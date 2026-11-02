export const PUBLIC_TEST_DURATION_MINUTES = 30;
export const PUBLIC_TEST_ROOMS = {
  secondCamera: '系统测试 · 第二机位',
} as const;
export type PublicTestMode = keyof typeof PUBLIC_TEST_ROOMS;
export const PUBLIC_TEST_RULES = '这是公开系统测试考试，长期开放，每次体验从点击开始起计时 30 分钟。\n\n领取测试账号需要通过协会官网账号和密码验证，每个官网用户绑定一个永久测试账号，再次领取仍为同一账号。领取后，用手机浏览器扫描客户端登录二维码或输入配对码并填写账号即可进入，仍需完成手持身份证明照片和环境视频采集，材料仅临时校验并立即丢弃，不保存到服务器，也无需登录请求或审核。必须连接手机第二机位；屏幕、电脑摄像头和手机三个画面全部通过真实推流检测后才能开始。测试不录制或保存画面，也不保存监考事件。临时登录与提交数据在体验结束后自动清理，绑定关系和测试登录凭据保留，后续可继续测试。\n\n可以体验设备检测、登录、实时推流、编程题提交和断网重连；测试成绩不参与正式比赛排名。';

// A placeholder keeps startup independent of judge availability. The configured
// problem is synchronized before the candidate reads or submits the exercise.
export const PUBLIC_TEST_PROBLEMS = [{
  order: 0, hydroDomain: 'public-system-test', hydroProblemId: 'A1',
  title: '测试题目', problemType: 'default', content: '',
  score: 100, scorePercent: 100, hydroScore: 100,
}];
