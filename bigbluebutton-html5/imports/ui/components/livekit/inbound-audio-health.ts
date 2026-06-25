import {
  ConnectionState,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import logger from '/imports/startup/client/logger';
import { liveKitRoom, LK_FATAL_ERROR_EVENT } from '/imports/ui/services/livekit';

// Subscriber-side audio health check (issue 25313). LiveKit does not surface
// subscriber peer-connection failures: pc.close() emits no connectionstatechange
// and there is no public RoomEvent for subscriber transport state. So we watch
// inbound audio flow through the public getStats API and, when a subscribed and
// unmuted remote microphone stops delivering packets, trigger the same fatal
// reconnect the publisher path uses (LK_FATAL_ERROR_EVENT -> full room reconnect,
// handled in components/livekit/component). This catches both pc.close() and
// silent media stalls.
//
// This lives at the room/component level (not the audio bridge) because the
// failure is on the RECEIVING side: every audio participant - including a
// listen-only viewer who never instantiates the publish-side bridge - must run
// it. It is driven by BBBLiveKitRoom (runs whenever usingAudio is true) and is a
// singleton over the shared liveKitRoom, so concurrent start() calls are no-ops.
const INBOUND_HEALTH_POLL_MS = 2000;
// Consecutive flat polls (insufficient packetsReceived advance) before declaring
// a stall. ~6s of silence on a track that should be delivering audio.
const INBOUND_STALL_THRESHOLD = 3;
// Minimum packetsReceived advance per poll for inbound audio to count as
// "flowing". A live publisher delivers ~100 audio packets per 2s poll (50/s
// Opus), far above this; a dead/stalled transport delivers ~0 - but often a tiny
// trickle (a stray packet, RTCP, a late retransmit), so a strict "any advance"
// check would be defeated by that trickle. Anything under this floor is not
// flowing.
const INBOUND_MIN_PACKETS_PER_POLL = 3;
// After a (re)connect or a recovery dispatch, suppress stall detection for this
// window so subscriptions can re-establish and a reconnect that does not restore
// flow cannot immediately re-trigger another one.
const RECONNECT_GRACE_MS = 10000;

interface FlowEntry {
  lastPackets: number;
  flatPolls: number;
}

const inboundFlowState = new Map<string, FlowEntry>();
let monitorHandle: ReturnType<typeof setInterval> | null = null;
let isChecking = false;
let inboundGraceUntil = 0;
let reconnectedHandlerAttached = false;

const isMicrophonePublication = (publication: RemoteTrackPublication): boolean => (
  publication.source === Track.Source.Microphone
);

// Sum inbound-rtp audio packetsReceived for a subscribed remote track via the
// public getStats API. Returns null when no inbound audio flow can be observed -
// either stats are unavailable (e.g. the underlying PC was closed, which makes
// getStats reject) or there is no inbound-rtp audio entry.
async function getInboundAudioPackets(track: RemoteTrack): Promise<number | null> {
  let report: RTCStatsReport | undefined;

  try {
    report = await track.getRTCStatsReport();
  } catch {
    return null;
  }

  if (!report) return null;

  let packets = 0;
  let sawInbound = false;

  report.forEach((stat) => {
    if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
      sawInbound = true;
      packets += stat.packetsReceived || 0;
    }
  });

  return sawInbound ? packets : null;
}

function isInboundCheckSuppressed(): boolean {
  return Date.now() < inboundGraceUntil;
}

// Route a subscriber-side audio failure into the shared fatal reconnect. A grace
// window + state reset here, plus the component-side guards (isReconnectingRef,
// MAX_CONN_ATTEMPTS), keep a failed recovery from looping.
function triggerSubscriberRecovery(reason: string): void {
  const suppressed = isInboundCheckSuppressed();
  // eslint-disable-next-line max-len
  logger.info({ logCode: 'livekit_lk25313' }, `[LK25313] triggerSubscriberRecovery reason="${reason}" suppressedByGrace=${suppressed} graceUntil=${inboundGraceUntil} now=${Date.now()}`);
  if (suppressed) return;

  logger.error({
    logCode: 'livekit_audio_subscriber_recovery',
    extraInfo: { reason },
  }, `LiveKit: subscriber audio failure detected, triggering reconnection - ${reason}`);

  inboundGraceUntil = Date.now() + RECONNECT_GRACE_MS;
  inboundFlowState.clear();
  // eslint-disable-next-line max-len
  logger.info({ logCode: 'livekit_lk25313' }, `[LK25313] triggerSubscriberRecovery DISPATCHING LK_FATAL_ERROR_EVENT reason="${reason}"`);
  window.dispatchEvent(new CustomEvent(LK_FATAL_ERROR_EVENT, {
    detail: { error: new Error(`LiveKit subscriber audio recovery: ${reason}`), source: 'audio' },
  }));
}

// Poll inbound audio flow on every remote microphone we should be hearing. When
// audio is EXPECTED (subscribed and the publisher is unmuted) but the inbound
// packet count does not advance over INBOUND_STALL_THRESHOLD consecutive polls,
// route it into the shared fatal reconnect. Covers two failure shapes LiveKit
// never surfaces: a silent media stall (PC open, packets flatline) and a dead
// subscriber transport (pc.close: getStats rejects / track gone). Legitimate
// silence is excluded up front (muted publisher, deliberately-unsubscribed
// track), and a track that never delivered a packet is never flagged.
async function checkInboundAudioFlow(): Promise<void> {
  if (isChecking) {
    logger.info({ logCode: 'livekit_lk25313' }, '[LK25313] poll SKIP: previous check still running');
    return;
  }
  if (isInboundCheckSuppressed()) {
    // eslint-disable-next-line max-len
    logger.info({ logCode: 'livekit_lk25313' }, `[LK25313] poll SKIP: suppressed by grace window graceUntil=${inboundGraceUntil} now=${Date.now()}`);
    return;
  }
  if (liveKitRoom.state !== ConnectionState.Connected) {
    logger.info({ logCode: 'livekit_lk25313' }, `[LK25313] poll SKIP: room state=${liveKitRoom.state} (not connected)`);
    return;
  }

  isChecking = true;

  try {
    const expected: RemoteTrackPublication[] = [];
    let micPubCount = 0;

    liveKitRoom.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach((publication) => {
        if (!isMicrophonePublication(publication)) return;

        micPubCount += 1;

        // Audio is only EXPECTED when we want the track (subscribed) and the
        // publisher is sending it (not muted). A muted publisher or a
        // deliberately-unsubscribed track is legitimate silence, not a failure:
        // drop its state and skip. pc.close() flips neither flag (the SDK gets no
        // signal), so a dead subscriber transport still lands here.
        if (!publication.isSubscribed || publication.isMuted) {
          // eslint-disable-next-line max-len
          logger.info({ logCode: 'livekit_lk25313' }, `[LK25313] gate FAIL sid=${publication.trackSid} isSubscribed=${publication.isSubscribed} isMuted=${publication.isMuted} hasTrack=${!!publication.track} -> dropped from expected`);
          inboundFlowState.delete(publication.trackSid);
          return;
        }

        // eslint-disable-next-line max-len
        logger.info({ logCode: 'livekit_lk25313' }, `[LK25313] gate PASS sid=${publication.trackSid} isSubscribed=${publication.isSubscribed} isMuted=${publication.isMuted} hasTrack=${!!publication.track}`);
        expected.push(publication);
      });
    });

    // eslint-disable-next-line max-len
    logger.info({ logCode: 'livekit_lk25313' }, `[LK25313] poll START micPubs=${micPubCount} expected=${expected.length} remoteParticipants=${liveKitRoom.remoteParticipants.size}`);

    const expectedSids = new Set(expected.map((pub) => pub.trackSid));

    // Drop state for tracks no longer expected (unpublished / participant left).
    Array.from(inboundFlowState.keys()).forEach((sid) => {
      if (!expectedSids.has(sid)) inboundFlowState.delete(sid);
    });

    let stalledSid: string | null = null;

    // eslint-disable-next-line no-restricted-syntax
    for (const publication of expected) {
      const { trackSid, track } = publication;
      // A null reading means no inbound audio is observable this poll: either
      // there is no attached track or getStats is unreachable (the subscriber PC
      // was closed - getStats rejects).
      const packets = track
        // eslint-disable-next-line no-await-in-loop
        ? await getInboundAudioPackets(track)
        : null;
      const prev = inboundFlowState.get(trackSid);
      const delta = (packets !== null && prev) ? packets - prev.lastPackets : null;
      const isFlat = packets === null
        ? !!(prev && prev.lastPackets > 0)
        : !!(prev && delta !== null && delta < INBOUND_MIN_PACKETS_PER_POLL && prev.lastPackets > 0);
      // eslint-disable-next-line max-len
      logger.info({ logCode: 'livekit_lk25313' }, `[LK25313] measure sid=${trackSid} hasTrack=${!!track} curPkts=${packets} prevPkts=${prev ? prev.lastPackets : 'none'} delta=${delta} min=${INBOUND_MIN_PACKETS_PER_POLL} flat=${isFlat} flatPollsBefore=${prev ? prev.flatPolls : 0}/${INBOUND_STALL_THRESHOLD}`);

      if (packets === null) {
        // Only a dead reading on a track that WAS delivering audio counts as a
        // failure - a dead subscriber transport. A track that never received a
        // packet is still ramping; wait.
        if (prev && prev.lastPackets > 0) {
          const flatPolls = prev.flatPolls + 1;
          inboundFlowState.set(trackSid, { lastPackets: prev.lastPackets, flatPolls });

          if (flatPolls >= INBOUND_STALL_THRESHOLD) {
            stalledSid = trackSid;
            break;
          }
        }
      } else if (!prev) {
        // First observation - seed the baseline, do not judge yet.
        inboundFlowState.set(trackSid, { lastPackets: packets, flatPolls: 0 });
      } else if (packets - prev.lastPackets >= INBOUND_MIN_PACKETS_PER_POLL) {
        // Meaningful inbound flow since the last poll - audio is healthy.
        inboundFlowState.set(trackSid, { lastPackets: packets, flatPolls: 0 });
      } else if (prev.lastPackets > 0) {
        // Audio is expected (subscribed, publisher unmuted) but flow is at/near
        // zero - a frozen counter or a trickle that never resumes. lastPackets
        // advances to the current count so we measure the per-poll rate.
        const flatPolls = prev.flatPolls + 1;
        inboundFlowState.set(trackSid, { lastPackets: packets, flatPolls });

        if (flatPolls >= INBOUND_STALL_THRESHOLD) {
          stalledSid = trackSid;
          break;
        }
      } else {
        // Never delivered meaningful audio yet (still ramping from zero). Keep
        // the baseline current and wait rather than flag it as dead.
        inboundFlowState.set(trackSid, { lastPackets: packets, flatPolls: 0 });
      }
    }

    if (stalledSid) {
      // eslint-disable-next-line max-len
      logger.info({ logCode: 'livekit_lk25313' }, `[LK25313] poll END: STALL REACHED sid=${stalledSid} -> calling triggerSubscriberRecovery`);
      triggerSubscriberRecovery(`inbound audio stalled - ${stalledSid}`);
    } else {
      logger.info({ logCode: 'livekit_lk25313' }, '[LK25313] poll END: no stall this round');
    }
  } catch (error) {
    logger.warn({
      logCode: 'livekit_audio_inbound_health_check_error',
      extraInfo: {
        errorMessage: (error as Error)?.message,
        errorName: (error as Error)?.name,
      },
    }, `LiveKit: inbound audio health check failed - ${(error as Error)?.message}`);
  } finally {
    isChecking = false;
  }
}

// Reset the stall detector and hold off detection while subscriptions
// re-establish after a reconnect.
function onRoomReconnected(): void {
  inboundFlowState.clear();
  inboundGraceUntil = Date.now() + RECONNECT_GRACE_MS;
  logger.info({ logCode: 'livekit_lk25313' }, `[LK25313] onRoomReconnected: reset detector + grace until ${inboundGraceUntil}`);
}

// Start the inbound audio health monitor. Idempotent: safe to call from every
// audio participant's BBBLiveKitRoom mount (publisher and listen-only alike).
export function startInboundAudioHealthMonitor(): void {
  if (liveKitRoom && !reconnectedHandlerAttached) {
    liveKitRoom.on(RoomEvent.Reconnected, onRoomReconnected);
    reconnectedHandlerAttached = true;
  }

  if (monitorHandle) {
    logger.info({ logCode: 'livekit_lk25313' }, '[LK25313] startInboundAudioHealthMonitor: already running (noop)');
    return;
  }

  monitorHandle = setInterval(() => { checkInboundAudioFlow(); }, INBOUND_HEALTH_POLL_MS);
  // eslint-disable-next-line max-len
  logger.info({ logCode: 'livekit_lk25313' }, `[LK25313] startInboundAudioHealthMonitor: STARTED interval=${INBOUND_HEALTH_POLL_MS}ms threshold=${INBOUND_STALL_THRESHOLD} minPkts=${INBOUND_MIN_PACKETS_PER_POLL}`);
}

export function stopInboundAudioHealthMonitor(): void {
  if (monitorHandle) {
    clearInterval(monitorHandle);
    monitorHandle = null;
    logger.info({ logCode: 'livekit_lk25313' }, '[LK25313] stopInboundAudioHealthMonitor: STOPPED');
  }

  if (liveKitRoom && reconnectedHandlerAttached) {
    liveKitRoom.off(RoomEvent.Reconnected, onRoomReconnected);
    reconnectedHandlerAttached = false;
  }

  inboundFlowState.clear();
  inboundGraceUntil = 0;
}
