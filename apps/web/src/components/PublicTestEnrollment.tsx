'use client';

import { useState } from 'react';
import { Copy, Smartphone, RefreshCw } from 'lucide-react';
import styles from '@/app/test/test.module.css';

type Credentials = { examCode: string; examName: string; name: string; examNumber: string; password: string; durationMinutes: number; mode: 'secondCamera' };
export default function PublicTestEnrollment() {
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Credentials['mode']>('secondCamera');
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  async function enroll() {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/public-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, account, password }), cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || '领取失败，请稍后再试');
      setCredentials(result.data);
      setPassword('');
    } catch (error) { setMessage(error instanceof TypeError ? '连接失败，请检查网络后重试' : error instanceof Error ? error.message : '领取失败，请稍后再试'); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!credentials) return;
    try {
      await navigator.clipboard.writeText(`考试编号：${credentials.examCode}\n姓名：${credentials.name}\n考号：${credentials.examNumber}\n密码：${credentials.password}`);
      setMessage('已复制，请在手机浏览器填写，扫描客户端登录二维码或输入配对码登录。');
    } catch { setMessage('请手动复制下方登录信息。'); }
  }
  return <section className={styles.panel}>
    <h2>第二机位环境测试</h2>
    <div className={styles.modes}>
      <label className={mode === 'secondCamera' ? styles.selected : ''}><input type="radio" name="test-mode" checked={mode === 'secondCamera'} onChange={() => { setMode('secondCamera'); setCredentials(null); }} /><Smartphone size={22} /><strong>第二机位</strong><span>必须使用手机第二机位，检测三个画面推流与断网重连</span></label>
    </div>
    <div className={styles.loginFields}>
      <p>先验证协会官网账号，再领取与你永久绑定的测试账号。此验证不会授予监考后台权限。</p>
      <label>官网账号或邮箱<input value={account} onChange={event => setAccount(event.target.value)} autoComplete="username" placeholder="官网不支持使用学号验证" /></label>
      <label>官网密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>
    </div>
    <label className={styles.notice}><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />我已了解：测试会实时检测屏幕和摄像头推流，不保存录像和监考事件。请使用测试身份。</label>
    <button className={styles.primary} onClick={() => void enroll()} disabled={busy || !acknowledged || !account.trim() || !password}>{busy ? '正在领取…' : credentials ? '验证并查看我的测试账号' : '领取我的测试账号'}</button>
    {message ? <p className={styles.message} role="status">{message}</p> : null}
    {credentials ? <div className={styles.credentials}>
      <div className={styles.credentialHeader}><h3>你的独立测试账号</h3><button onClick={() => void copy()}><Copy size={15} />复制登录信息</button></div>
      <dl><dt>考试编号</dt><dd>{credentials.examCode}</dd><dt>姓名</dt><dd>{credentials.name}</dd><dt>考号</dt><dd>{credentials.examNumber}</dd><dt>密码</dt><dd>{credentials.password}</dd></dl>
      <p>在客户端完成设备检测后，选择<strong>二维码登录</strong>。使用手机浏览器扫描此二维码或输入客户端显示的配对码，在浏览器中填写上面四项信息后登录；按页面完成手持身份证明照片和环境视频采集后登录，材料仅在内存中校验，不保存到服务器，也无需提交登录请求或等待审核。登录后连接手机摄像头并检测推流。三个画面推流通过后才能开始体验。点击“开始考试”后计时 {credentials.durationMinutes} 分钟。</p>
      <p><RefreshCw size={15} />测试期间，客户端右上角和手机监考页面会显示“断网重连测试”。点击后退出当前连接，按提示重新扫码。请在两分钟内完成重连。</p>
      <p>同一官网用户在任何浏览器再次领取都会返回相同账号；结束后可用原账号重新测试。体验题由管理员配置，可测试编程题的语言选择、代码提交和测评。测试成绩不参与正式排名，临时登录和提交数据在结束后自动清理，账号和官网绑定永久保留。</p>
    </div> : null}
  </section>;
}
