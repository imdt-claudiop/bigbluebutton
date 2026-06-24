// @ts-nocheck -- BlockNote schema-generic types unresolved for custom block; same as LatexBlock
import { createReactBlockSpec } from '@blocknote/react';
import * as React from 'react';
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { parseChartSpec, ChartSpec } from './parseChartSpec';

const SLICE_COLORS = [
  '#0C57A7', '#F2C14E', '#3FA796', '#E36588', '#7E60BF',
  '#F29E4C', '#5BC0BE', '#C03221', '#6A994E', '#577590',
];

const renderChart = (chart: ChartSpec) => {
  if (chart.type === 'pie') {
    return (
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Tooltip />
          <Pie
            data={chart.data}
            dataKey="value"
            nameKey="label"
            outerRadius={100}
            isAnimationActive={false}
            label={(entry) => entry.label}
          >
            {chart.data.map((entry, index) => (
              // Static, non-reordering slice list; color maps to position.
              // eslint-disable-next-line react/no-array-index-key
              <Cell key={`slice-${index}-${entry.label}`} fill={SLICE_COLORS[index % SLICE_COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ScatterChart>
        <Tooltip cursor={{ strokeDasharray: '3 3' }} />
        <XAxis type="number" dataKey="x" name="x" />
        <YAxis type="number" dataKey="y" name="y" />
        <Scatter data={chart.data} fill="#0C57A7" isAnimationActive={false} />
      </ScatterChart>
    </ResponsiveContainer>
  );
};

const ChartBlockContent: React.FC<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any;
}> = ({ block, editor }) => {
  const [editing, setEditing] = React.useState(
    !block.props.spec || block.props.spec === '',
  );
  const [spec, setSpec] = React.useState(block.props.spec || '');
  const [error, setError] = React.useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    setSpec(block.props.spec || '');
  }, [block.props.spec]);

  React.useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editing]);

  const renderSpec = () => {
    if (!spec || spec.trim() === '') {
      return (
        <span className="chart-block-placeholder">
          Click to insert a chart (pie or scatter JSON)
        </span>
      );
    }
    const result = parseChartSpec(spec);
    if (!result.ok) {
      return (
        <span className="chart-block-error">
          {result.error}
        </span>
      );
    }
    return renderChart(result.value);
  };

  const commitSpec = (newSpec: string) => {
    const trimmed = newSpec.trim();
    editor.updateBlock(block, {
      type: 'chart' as const,
      props: { spec: trimmed },
    });
    setError(null);
    if (trimmed) {
      const result = parseChartSpec(trimmed);
      if (result.ok) {
        setEditing(false);
      } else {
        setError(result.error);
      }
    } else {
      setEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      // Shift+Enter = commit and render
      e.preventDefault();
      commitSpec(spec);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setSpec(block.props.spec || '');
      setError(null);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <div className="chart-block chart-block-editing" contentEditable={false}>
        <textarea
          ref={textareaRef}
          className="chart-block-textarea"
          value={spec}
          onChange={(e) => {
            setSpec(e.target.value);
            setError(null);
          }}
          onBlur={() => commitSpec(spec)}
          onKeyDown={handleKeyDown}
          placeholder={'{ "type": "pie", "data": [ { "label": "Yes", "value": 12 } ] }'}
          rows={4}
        />
        {error && <div className="chart-block-error">{error}</div>}
        <div className="chart-block-hint">
          Press Enter+Shift to render &bull; Esc to cancel
        </div>
      </div>
    );
  }

  return (
    <div
      className="chart-block chart-block-rendered"
      contentEditable={false}
      onClick={() => setEditing(true)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setEditing(true);
        }
      }}
    >
      <div className="chart-block-content">{renderSpec()}</div>
    </div>
  );
};

export const createChartBlock = createReactBlockSpec(
  {
    type: 'chart',
    propSchema: {
      spec: {
        default: '',
      },
    },
    content: 'none',
  },
  {
    render: (props) => (
      <ChartBlockContent
        block={props.block}
        editor={props.editor}
      />
    ),
  },
);

export default createChartBlock;
