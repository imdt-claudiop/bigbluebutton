// Real subscriber-side audio FLATLINE (issue 25313).
//
// The viewer stays SUBSCRIBED and the moderator stays UNMUTED+SENDING, but the
// viewer's inbound RTP is silently dropped at the OS level for a window longer
// than the detection threshold (~6s). We drop ONLY RTP/RTCP (UDP payload whose
// first byte has the RTP v2 bits set, 0x80..) to the viewer's receiving port and
// LET STUN/DTLS THROUGH, so ICE consent stays alive and the PeerConnection keeps
// believing it is connected - a genuine silent media death, not an ICE teardown.
//
// getStats keeps returning a FROZEN packetsReceived on that still-open PC; the
// fix's health check must see the flatline and trigger LK_FATAL_ERROR_EVENT ->
// room reconnect -> a fresh subscriber transport (new local port, not dropped) ->
// audio resumes.
//
// Proof obligations printed: before gain (~200), DURING-drop gain (~0, proving the
// flatline is real), after-recovery gain (>50), and recovery markers.
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const H = require('./lib');

// Drop / undrop only RTP-RTCP (v2) to a given local UDP port on this host's INPUT.
// STUN (first byte 0x00/0x01) and DTLS (0x14..0x17) have the top two bits clear,
// so they are NOT matched and keep flowing -> ICE/DTLS stay alive.
const U32_RTP = '28 & 0xc0000000 = 0x80000000';
function dropRtp(port) {
  execSync(`sudo -n iptables -I INPUT -p udp --dport ${port} -m u32 --u32 "${U32_RTP}" -j DROP`);
}
function undropRtp(port) {
  try {
    execSync(`sudo -n iptables -D INPUT -p udp --dport ${port} -m u32 --u32 "${U32_RTP}" -j DROP`);
  } catch (e) { /* already gone */ }
}

// In the page: find the PC currently receiving inbound audio and return its
// SELECTED local ICE candidate (the local UDP socket inbound RTP lands on).
async function findReceivingLocalCandidate(page) {
  return page.evaluate(async () => {
    for (const pc of (window.__pcs || [])) {
      if (pc.connectionState === 'closed' || pc.signalingState === 'closed') continue;
      let stats; try { stats = await pc.getStats(); } catch (e) { continue; }
      let recv = 0;
      stats.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') recv += (r.packetsReceived || 0); });
      if (recv <= 0) continue;
      // Locate the selected candidate pair (via transport, or nominated/succeeded).
      let selectedPairId = null;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) selectedPairId = r.selectedCandidatePairId; });
      let pair = selectedPairId ? stats.get(selectedPairId) : null;
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r; });
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded') pair = r; });
      if (!pair) continue;
      const local = stats.get(pair.localCandidateId);
      if (local && local.port) {
        return { port: local.port, ip: local.address || local.ip, protocol: local.protocol, type: local.candidateType, recv };
      }
    }
    return null;
  });
}

(async () => {
  const meetingID = await H.createMeeting('flat');
  const browser = await chromium.launch({ headless: true, args: H.launchArgs });
  const modCtx = await browser.newContext({ permissions: ['microphone'] });
  const viewCtx = await browser.newContext({ permissions: ['microphone'] });
  await modCtx.addInitScript(H.INIT);
  await viewCtx.addInitScript(H.INIT);
  const mod = await modCtx.newPage();
  const view = await viewCtx.newPage();
  const markers = [];
  H.captureRecoveryMarkers(view, markers);

  let droppedPort = null;
  try {
    await mod.goto(H.joinUrl(meetingID, 'Moderator-F', true), { waitUntil: 'networkidle', timeout: 90000 });
    await H.joinMicAndUnmute(mod, 'mod');
    await view.goto(H.joinUrl(meetingID, 'Viewer-F', false), { waitUntil: 'networkidle', timeout: 90000 });
    await H.joinListenOnly(view, 'view');
    await view.waitForTimeout(4000);

    const before = await H.measureGain(view, 4000);
    console.log(`[F] BEFORE gain/4s = ${before.gained}`);

    const cand = await findReceivingLocalCandidate(view);
    if (!cand || !cand.port) {
      console.log('[F] FAILED to locate receiving local candidate port; cannot induce flatline.');
      await browser.close();
      process.exit(2);
    }
    console.log(`[F] receiving local candidate: ${JSON.stringify(cand)}`);

    // Induce the flatline: drop only RTP/RTCP to the viewer's receiving port.
    droppedPort = cand.port;
    dropRtp(droppedPort);
    console.log(`[F] INDUCE: dropping inbound RTP/RTCP to udp/${droppedPort} (STUN/DTLS still pass)`);

    // Measure DURING the drop - must be ~0 to prove reception really stopped.
    const during = await H.measureGain(view, 4000);
    console.log(`[F] DURING-DROP gain/4s = ${during.gained} (expect ~0)`);

    // Keep the drop ACTIVE through the detection + recovery window. ICE/DTLS stay
    // alive (only RTP is dropped), so the old PC never dies on its own: the ONLY
    // way audio resumes here is the fix detecting the flatline and reconnecting
    // onto a FRESH subscriber PC with a NEW local port (not covered by the drop
    // rule). So AFTER-while-dropped > 50 == the fix genuinely recovered.
    console.log('[F] holding drop; waiting 24s for flatline detection + reconnect onto a fresh port...');
    await view.waitForTimeout(24000);
    const afterDropped = await H.measureGain(view, 4000);
    console.log(`[F] AFTER-while-dropped gain/4s = ${afterDropped.gained} (>50 == fix reconnected to a fresh port)`);
    console.log(`[F] recovery markers: ${JSON.stringify([...new Set(markers)])}`);

    // Sanity: lift the drop. If audio now resumes on the SAME still-alive PC, the
    // flatline was pure media loss (PC never died) - confirms a real silent stall
    // rather than a transport teardown.
    undropRtp(droppedPort);
    droppedPort = null;
    await view.waitForTimeout(6000);
    const afterLift = await H.measureGain(view, 4000);
    console.log(`[F] AFTER-LIFT gain/4s = ${afterLift.gained} (sanity: PC was alive => pure media flatline)`);

    const flatlineReal = during.gained <= 20;                  // reception really stopped
    const recoveredByFix = afterDropped.gained > 50;           // resumed WHILE still dropped => reconnect
    console.log(`[F] RESULT before=${before.gained} during=${during.gained} afterDropped=${afterDropped.gained} afterLift=${afterLift.gained}`);
    console.log(`[F] FLATLINE_REAL = ${flatlineReal ? 'YES' : 'NO'}`);
    console.log(`[F] FLATLINE_RECOVERED_BY_FIX = ${recoveredByFix ? 'YES' : 'NO'}`);

    await browser.close();
    process.exit(flatlineReal && recoveredByFix ? 0 : 1);
  } catch (e) {
    console.error('[F fatal]', e);
    await browser.close().catch(() => {});
    process.exit(4);
  } finally {
    if (droppedPort) undropRtp(droppedPort);
  }
})();
