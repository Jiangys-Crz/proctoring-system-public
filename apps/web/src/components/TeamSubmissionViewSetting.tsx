'use client';

export function TeamSubmissionViewSetting({ contestType, teamAccountMode, enabled, onChange, helpClassName = 'exam-field-help', showHelp = true }: {
  contestType: 'INDIVIDUAL' | 'TEAM';
  teamAccountMode: 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT';
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  helpClassName?: string;
  showHelp?: boolean;
}) {
  if (contestType !== 'TEAM') return showHelp ? <p className={helpClassName}>提交记录、代码和提交详情仅本人可查看。</p> : null;
  if (teamAccountMode === 'TEAM_ACCOUNT') return showHelp ? <p className={helpClassName}>全队共用一个账号时，成员共用该账号的提交记录。其他队伍无法查看。</p> : null;
  return <div>
    <label className="exam-checkbox"><input type="checkbox" role="switch" className="settings-switch" checked={enabled} onChange={event => onChange(event.target.checked)} /> 允许同队成员查看提交</label>
    {showHelp ? <p className={helpClassName}>默认仅本人可查看。开启后，同队成员可查看彼此的提交记录、代码和详情；考试的成绩显示与封榜规则仍然生效。</p> : null}
  </div>;
}
