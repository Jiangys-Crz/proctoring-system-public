import styles from './ReactionAdmin.module.css';

/** Documentation only: never read or serialize actual service credentials. */
export function ReactionCcsSetupHelp() {
  return <details className={styles.ccsHelp} id="reaction-ccs-setup">
    <summary>首次使用：CCS 授权在哪里填写？</summary>
    <div className={styles.ccsHelpBody}>
      <p>Reaction 需要监考服务端登录 NovaJudge 的 CCS 事件接口。当前通过服务器环境配置填写，后台没有账号密码输入框；无需给每场比赛单独批准。</p>
      <ol>
        <li>准备 <strong>NovaJudge 全局超级管理员（SUPER_ADMIN）</strong>的账号和密码。监考后台账号、比赛内管理员账号、外榜 API Key 和直播 API Key 都不能替代；浏览器登录也不会自动授权 Recorder。</li>
        <li>由部署者编辑监考仓库的 <code>apps/web/.env</code>，按下方示例填写三项。已有文件直接修改对应项，不要覆盖其他配置。</li>
        <li>地址只填写协议、域名和端口，必须与本场考试的 NovaJudge 平台地址一致，不加比赛路径。<code>localhost</code> 与 <code>127.0.0.1</code> 不是同一个地址。</li>
        <li>保存后重启 <strong>Reaction Recorder</strong>，并让 Web 服务加载相同配置。Docker 或服务管理器部署时，需要把变量传给实际进程并重新创建或重启对应服务。</li>
        <li>刷新本页，运行状态显示“已连接”才表示验证成功。开赛前也应能连接；同一 NovaJudge 后续新建比赛会复用默认配置。</li>
      </ol>
      <pre>{`# 示例占位符，请由部署者替换；不要把真实密码提交到 Git
REACTION_CCS_ORIGIN=https://judge.example.org
REACTION_CCS_USERNAME=your-novajudge-global-admin
REACTION_CCS_PASSWORD="your-novajudge-account-password"`}</pre>
      <p className="muted">本机部署地址可用 <code>http://127.0.0.1:3001</code>，外部服务器使用 HTTPS。若部署者设置了 <code>REACTION_CCS_CREDENTIALS</code> 单考试映射，它优先于默认三项；键是本页 URL 中的监考考试内部 ID，不是 NovaJudge 比赛编号。完整部署与排查说明见仓库 <code>docs/reaction-ccs-auth.md</code>。</p>
    </div>
  </details>;
}
