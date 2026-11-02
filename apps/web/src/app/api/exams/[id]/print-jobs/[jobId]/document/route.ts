import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessExam, canAccessCandidate } from '@/lib/permissions';

const esc = (value: unknown) => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

function wrapPrintContent(content: string, columns = 84) {
  const output: string[] = [];
  for (const sourceLine of content.replace(/\r\n?/g, '\n').split('\n')) {
    if (!sourceLine) { output.push(''); continue; }
    let line = ''; let width = 0;
    for (const char of sourceLine) {
      const charWidth = char === '\t' ? 4 : /[\u0000-\u00ff]/.test(char) ? 1 : 2;
      if (width + charWidth > columns && line) { output.push(line); line = ''; width = 0; }
      line += char; width += charWidth;
    }
    output.push(line);
  }
  return output;
}

export async function GET(request: Request, context: { params: Promise<{ id: string; jobId: string }> }) {
  let user;
  try { user = await requireUser(); }
  catch (error) {
    if (error instanceof AuthError) return new Response(error.message, { status: error.status });
    throw error;
  }
  const { id, jobId } = await context.params;
  if (!(await canAccessExam(user, id))) return new Response('Forbidden', { status: 403 });
  const job = await prisma.printJob.findFirst({ where: { id: jobId, examId: id } });
  if (!job) return new Response('Not Found', { status: 404 });
  if (!(await canAccessCandidate(user, job.candidateId))) return new Response('Forbidden', { status: 403 });
  const person = job.teamName
    ? `队伍名称：${esc(job.teamName)}　队伍成员：${esc(job.teamMembers)}`
    : `姓名：${esc(job.candidateName || job.examNumber)}`;
  const auto = new URL(request.url).searchParams.get('print') === '1';
  const lines = wrapPrintContent(job.content);
  const linesPerPage = 48;
  const pages = Array.from({ length: Math.max(1, Math.ceil(lines.length / linesPerPage)) }, (_, index) => lines.slice(index * linesPerPage, (index + 1) * linesPerPage));
  const metadata = `打印时间：${esc(job.createdAt.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}　${person}　考室：${esc(job.roomName)}　座位号：${esc(job.seatNo)}`;
  const sheets = pages.map((page, index) => `<article class="sheet${index ? '' : ' active'}" data-page="${index + 1}"><div class="meta">${metadata}　页码：${index + 1}/${pages.length}</div><pre class="content">${esc(page.join('\n'))}</pre></article>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(job.title)}</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font:14px/1.7 Arial,"Microsoft YaHei",sans-serif;color:#172027;background:#e7ecef}.preview-toolbar{position:sticky;top:0;z-index:5;height:52px;display:flex;align-items:center;justify-content:center;gap:14px;border-bottom:1px solid #d5dde2;background:rgba(255,255,255,.96);box-shadow:0 5px 18px rgba(43,61,70,.08)}.preview-toolbar button{width:34px;height:30px;border:1px solid #d7e0e5;border-radius:7px;color:#52656f;background:#fff;cursor:pointer;font-size:18px}.preview-toolbar button:disabled{opacity:.35;cursor:not-allowed}.preview-toolbar strong{min-width:92px;color:#3f515b;text-align:center;font-size:13px}.pages{padding:22px}.sheet{position:relative;width:210mm;min-height:297mm;margin:0 auto;padding:18mm;background:#fff;box-shadow:0 12px 38px rgba(43,61,70,.18);display:none}.sheet.active{display:block}.meta{border-bottom:1px solid #aeb7bc;padding-bottom:10px;margin-bottom:18px;color:#2f3a40;white-space:normal;font-size:12px}.content{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;line-height:1.55}@media(max-width:900px){.pages{padding:12px}.sheet{width:100%;min-height:calc((100vw - 24px)*1.414);padding:7vw}}@media print{@page{size:A4;margin:0}html,body{background:#fff}.preview-toolbar{display:none}.pages{padding:0}.sheet,.sheet.active{display:block;width:210mm;height:297mm;min-height:297mm;margin:0;padding:18mm;box-shadow:none;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}}</style></head><body><nav class="preview-toolbar" aria-label="打印预览翻页"><button id="prev" type="button" aria-label="上一页">‹</button><strong><span id="current">1</span> / ${pages.length}</strong><button id="next" type="button" aria-label="下一页">›</button></nav><main class="pages">${sheets}</main><script>(()=>{const sheets=[...document.querySelectorAll('.sheet')],current=document.getElementById('current'),prev=document.getElementById('prev'),next=document.getElementById('next');let page=0;function show(value){page=Math.max(0,Math.min(sheets.length-1,value));sheets.forEach((sheet,index)=>sheet.classList.toggle('active',index===page));current.textContent=String(page+1);prev.disabled=page===0;next.disabled=page===sheets.length-1;scrollTo(0,0)}prev.onclick=()=>show(page-1);next.onclick=()=>show(page+1);addEventListener('keydown',event=>{if(event.key==='ArrowLeft')show(page-1);if(event.key==='ArrowRight')show(page+1)});show(0);${auto ? 'addEventListener("load",()=>setTimeout(()=>window.print(),80));' : ''}})()<\/script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
