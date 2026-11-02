(function (root) {
  function preferCodec(transceiver, mimeType, exclusive) {
    if (typeof transceiver.setCodecPreferences !== 'function') return false;
    try {
      // Older browsers validate preferences against receiver capabilities even
      // for sendonly transceivers. Preserve their exact codec dictionaries.
      const sender = root.RTCRtpSender?.getCapabilities?.('video')?.codecs;
      const receiver = root.RTCRtpReceiver?.getCapabilities?.('video')?.codecs;
      const parameters = (codec) => (codec.sdpFmtpLine || '').split(';').map(part => part.trim()).filter(Boolean).sort().join(';');
      const matches = (a, b) => a.mimeType.toLowerCase() === b.mimeType.toLowerCase()
        && a.clockRate === b.clockRate && a.channels === b.channels && parameters(a) === parameters(b);
      const codecs = receiver && sender
        ? receiver.filter(codec => sender.some(other => matches(codec, other)))
        : receiver || sender || [];
      if (!codecs.some(codec => codec.mimeType.toLowerCase() === mimeType)) return false;
      // A decoder advertised by the browser can still fail at local SDP setup.
      // The VP8 recovery offer must omit H264 entirely, including other profiles.
      const candidates = exclusive ? codecs.filter(codec => [mimeType, 'video/rtx'].includes(codec.mimeType.toLowerCase())) : codecs;
      const ordered = [...candidates].sort((a, b) => Number(b.mimeType.toLowerCase() === mimeType) - Number(a.mimeType.toLowerCase() === mimeType));
      transceiver.setCodecPreferences(ordered);
      return true;
    } catch {
      // Codec preference is an optimisation. A platform-specific rejection
      // must not abort publishing; an empty list restores browser negotiation.
      try { transceiver.setCodecPreferences([]); } catch {}
      return false;
    }
  }
  root.proctorPreferH264 = function (transceiver) {
    return preferCodec(transceiver, 'video/h264', false);
  };
  root.proctorPreferVp8 = function (transceiver) {
    return preferCodec(transceiver, 'video/vp8', true);
  };
})(globalThis);
