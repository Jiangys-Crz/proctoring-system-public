export type LoginMethod = 'CREDENTIALS' | 'SECOND_CAMERA_QR';
export class LoginFlowError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function requireRoomLoginMethod(room: { loginMode: LoginMethod } | null, method: LoginMethod) {
  if (!room) throw new LoginFlowError('该考生尚未分配考室，请联系监考老师配置考室后登录', 403);
  if (room.loginMode === method) return;
  throw new LoginFlowError(method === 'CREDENTIALS'
    ? '所在考室不允许账号密码登录，请改用二维码登录'
    : '所在考室不允许二维码登录，请在电脑客户端改用考试编号＋姓名＋考号＋密码登录', 403);
}
