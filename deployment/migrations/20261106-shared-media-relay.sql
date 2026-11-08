-- Apply after backup, before starting the shared-media relay backend.
-- Existing reservations remain WebRTC; no exam/media records are removed.
ALTER TABLE `LiveRelayWebRtcConnection`
  ADD COLUMN `protocol` VARCHAR(8) NOT NULL DEFAULT 'webrtc';
CREATE INDEX `LiveRelayWebRtcConnection_protocol_mediaId_idx`
  ON `LiveRelayWebRtcConnection` (`protocol`, `mediaId`);
