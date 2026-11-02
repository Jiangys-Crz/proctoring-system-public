declare global {
  var proctorPreferH264: (transceiver: RTCRtpTransceiver) => boolean;
  var proctorPreferVp8: (transceiver: RTCRtpTransceiver) => boolean;
}
export {};
