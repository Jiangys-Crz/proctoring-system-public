// Cheating and peripheral changes use the fullscreen security overlay;
// ordinary exam windows remain movable and resizable.
(function (root) {
  root.proctorWindowPolicy = function (session) {
    if (!session || session.status === 'FINISHED') return { mode: 'setup', cheating: false };
    const reason = session.lockdownReason || '';
    const cheating = Boolean(session.lockdown && /被.+标记为作弊/.test(reason));
    const peripheral = Boolean(session.lockdown && /外设/.test(reason) && /接入|移除|拔|插|检测.*(?:失败|异常|不可用|中断)/.test(reason));
    return { mode: cheating || peripheral ? 'locked' : 'floating', cheating };
  };
})(globalThis);
