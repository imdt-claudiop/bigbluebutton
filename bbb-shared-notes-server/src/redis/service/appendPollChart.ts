import hocuspocus from '../../hocuspocus';
import { Logger } from '../../common/logger';
import { getNotesEditor } from './notesSchema';

const logger = new Logger('redis.service.appendPollChart');

export interface PieEntry {
  label: string;
  value: number;
}

/**
 * Append (or update) a pie chart block summarising a poll's results to a meeting's
 * Shared Notes pad.
 *
 * Unlike `pushInitialContent` (which seeds an empty pad), this APPENDS to a pad
 * that already has content: it reads the current blocks and re-writes them plus the
 * new chart. `blocksToYXmlFragment` diffs against the live Yjs fragment
 * (y-prosemirror), so re-writing the unchanged blocks plus one new block is a
 * minimal, append-only change that leaves existing notes intact.
 *
 * Idempotent by `pollId`: the poll id is embedded in the chart spec JSON, so a
 * republished poll updates its existing chart in place instead of stacking a
 * duplicate. The id lives inside `spec` on purpose - it keeps the block's propSchema
 * (`{ spec: { default: '' } }`) byte-for-byte identical to the html5 client's; a
 * dedicated prop would diverge the shared collaborative schema. The html5 validator
 * (`parseChartSpec`) reads only `type` and `data`, so the extra field is ignored on
 * render.
 */
export async function appendPollChartToNotes(
  padId: string,
  pollId: string,
  data: PieEntry[],
): Promise<{ statusCode: string; error?: string }> {
  let connection: Awaited<ReturnType<typeof hocuspocus.openDirectConnection>> | null = null;
  try {
    const editor = getNotesEditor();
    connection = await hocuspocus.openDirectConnection(padId);

    const doc = connection.document;
    if (!doc) {
      return { statusCode: 'document_unavailable', error: 'Document not found' };
    }

    const fragment = doc.getXmlFragment('doc');
    const spec = JSON.stringify({ type: 'pie', pollId, data });

    const existingBlocks = editor.yXmlFragmentToBlocks(fragment);

    let replaced = false;
    // BlockNote's Block generics are intentionally loose here (`any`): we only read
    // a string prop and shallow-copy, and the strongly-typed work is the pie data
    // built upstream in the handler.
    const nextBlocks = existingBlocks.map((block: any) => {
      if (block?.type === 'chart' && typeof block?.props?.spec === 'string') {
        try {
          if (JSON.parse(block.props.spec)?.pollId === pollId) {
            replaced = true;
            return { ...block, props: { ...block.props, spec } };
          }
        } catch {
          // Not a poll-managed chart spec; leave it untouched.
        }
      }
      return block;
    });

    if (!replaced) {
      nextBlocks.push({ type: 'chart', props: { spec } });
    }

    editor.blocksToYXmlFragment(nextBlocks, fragment);

    logger.info('Poll chart written to notes', {
      padId, pollId, replaced, slices: data.length,
    });
    return { statusCode: replaced ? 'chart_replaced' : 'chart_appended' };
  } catch (error) {
    logger.error('Error appending poll chart to notes', { error, padId, pollId });
    return {
      statusCode: 'unknown_error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    if (connection) await connection.disconnect();
  }
}
