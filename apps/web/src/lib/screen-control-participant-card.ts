import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type CreateText, type OverlayOptions } from 'sharp';
import { splitMemberText } from './candidate-verify';
import { prisma } from './db';
import { processMedia } from './media-processing';
import { normalizeReactionOrganizationName } from './reaction-branding-contract';
import { readBuiltinReactionBadge, resolveReactionBrandingLogo } from './reaction-branding';
import { readReactionAsset } from './reaction-presentation';
import { reactionLogoOrganizationName } from './reaction-render-settings';
import {
  SCREEN_CONTROL_PARTICIPANT_HEIGHT as HEIGHT,
  SCREEN_CONTROL_PARTICIPANT_WIDTH as WIDTH,
  ScreenControlError,
} from './screen-control-policy';
import { cachedScreenControlBuffer, escapeMarkup } from './screen-control-render';

type TeamMember = { name: string | null; isTeamLeader: boolean; memberOrder: number };
type ParticipantCard = {
  examName: string;
  examNumber: string;
  isTeam: boolean;
  name: string;
  members: string[];
  organization: string;
};

const memberSelect = { name: true, isTeamLeader: true, memberOrder: true } as const;

export function orderedScreenParticipantNames(members: TeamMember[]) {
  return [...members]
    .sort((a, b) => Number(b.isTeamLeader) - Number(a.isTeamLeader) || a.memberOrder - b.memberOrder)
    .map(member => member.name?.trim())
    .filter((name): name is string => Boolean(name));
}

function rosterMembers(value: unknown): TeamMember[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((member: unknown, index) => {
    if (!member || typeof member !== 'object' || !('name' in member) || typeof member.name !== 'string') return [];
    return [{
      name: member.name,
      isTeamLeader: 'isTeamLeader' in member && member.isTeamLeader === true,
      memberOrder: 'memberOrder' in member && typeof member.memberOrder === 'number' ? member.memberOrder : index + 1,
    }];
  });
}

async function participantCard(examId: string, candidateId: string): Promise<ParticipantCard> {
  const candidate = await prisma.candidate.findFirst({
    where: { id: candidateId, examId },
    select: {
      name: true, examNumber: true, teamName: true, teamRoster: true, teamMembers: true, isTeamLeader: true, school: true, college: true,
      exam: { select: { name: true, contestType: true, teamAccountMode: true, reactionLogoMatchBy: true } },
    },
  });
  if (!candidate) throw new ScreenControlError('考生不属于本场考试', 404);
  const { exam } = candidate;
  const isTeam = exam.contestType === 'TEAM';
  let members: string[] = [];
  if (isTeam) {
    if (exam.teamAccountMode === 'TEAM_ACCOUNT') {
      members = orderedScreenParticipantNames(rosterMembers(candidate.teamRoster));
    } else if (candidate.teamName) {
      const accounts = await prisma.candidate.findMany({
        where: { examId, teamName: candidate.teamName },
        select: { ...memberSelect, teamName: true },
        orderBy: { examNumber: 'asc' },
      });
      members = orderedScreenParticipantNames(accounts.filter(account => account.teamName === candidate.teamName));
    }
    if (!members.length) {
      const name = candidate.name?.trim();
      members = splitMemberText(candidate.teamMembers);
      const leaderIndex = name && (candidate.isTeamLeader || exam.teamAccountMode === 'TEAM_ACCOUNT') ? members.indexOf(name) : -1;
      if (leaderIndex > 0) members.unshift(...members.splice(leaderIndex, 1));
      if (!members.length && name) members.push(name);
    }
  }
  const organization = reactionLogoOrganizationName(exam.reactionLogoMatchBy, candidate);
  return {
    examName: exam.name,
    examNumber: candidate.examNumber,
    isTeam,
    name: (isTeam ? candidate.teamName : candidate.name)?.trim() || candidate.examNumber,
    members,
    organization: organization ? normalizeReactionOrganizationName(organization) : '',
  };
}

const cardPanel = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <defs><clipPath id="card"><rect x="52" y="822" width="1816" height="233" rx="15"/></clipPath></defs>
  <g clip-path="url(#card)">
    <rect x="52" y="822" width="1816" height="233" fill="#fdfbf9"/>
    <rect x="52" y="822" width="1816" height="49" fill="#a95056"/>
    <path d="M76 1022h1768" stroke="#ece4e1"/>
  </g>
  <g fill="none" stroke="#fff6f2" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M82 836h16v7a8 8 0 0 1-16 0z M82 838h-5v3a5 5 0 0 0 5 5 M98 838h5v3a5 5 0 0 1-5 5 M90 851v6m-6 0h12"/>
  </g>
</svg>`);

let background: Promise<Buffer> | undefined;
function readBackground() {
  background ??= readFile(path.resolve(/* turbopackIgnore: true */ process.cwd(), 'assets/screen-control-foxes.webp'))
    .catch(error => { background = undefined; throw error; });
  return background;
}

async function cardText(
  value: string, left: number, top: number, width: number, height: number, fontSize: number, color: string, bold = false,
) {
  const text = escapeMarkup(value.replace(/\s+/gu, ' ').trim());
  if (!text) return null;
  const options: CreateText = {
    text: `<span foreground="${color}"${bold ? ' weight="bold"' : ''}>${text}</span>`,
    font: `sans-serif ${fontSize}`, width, height, rgba: true, wrap: 'word-char',
  };
  let rendered = await sharp({ text: options }).png().toBuffer({ resolveWithObject: true });
  if ((rendered.info.textAutofitDpi || 72) > 72) {
    rendered = await sharp({ text: { ...options, height: undefined, dpi: 72 } }).png().toBuffer({ resolveWithObject: true });
  }
  return { input: rendered.data, left, top, width: rendered.info.width };
}

export async function renderScreenControlParticipantCard(source: Buffer, logo: Buffer, card: ParticipantCard) {
  return processMedia(async () => {
    const name = await cardText(card.name, 244, 919, card.members.length ? 680 : 1580, 60, 52, '#222227', true);
    const membersLeft = 244 + (name?.width ?? 0) + 28;
    const [badge, ...labels] = await Promise.all([
      sharp(logo).resize(124, 124, { fit: 'contain', background: '#00000000' }).png().toBuffer(),
      cardText(card.examName, 115, 833, 1718, 30, 29, '#fff8f3', true),
      cardText(`${card.isTeam ? 'TEAM' : '考号'}   ${card.examNumber}`, 244, 886, 1570, 27, 22, '#706268', true),
      cardText(card.members.join('   ·   '), membersLeft, 937, 1833 - membersLeft, 34, 25, '#65595d'),
      cardText(card.organization, 244, 985, 1580, 30, 25, '#65595d'),
      cardText(card.examName, 77, 1030, 1750, 18, 16, '#827578'),
    ]);
    const overlays: OverlayOptions[] = [{ input: cardPanel }, { input: badge, left: 82, top: 886 }];
    for (const label of [name, ...labels]) {
      if (label) overlays.push({ input: label.input, left: label.left, top: label.top });
    }
    return sharp(source).composite(overlays).webp({ quality: 92 }).toBuffer();
  });
}

export async function getScreenControlParticipantCard(examId: string, candidateId: string) {
  const card = await participantCard(examId, candidateId);
  const badge = await resolveReactionBrandingLogo(card.organization || null);
  const key = createHash('sha256').update(JSON.stringify(['participant-card', card, badge.path])).digest('hex');
  return cachedScreenControlBuffer(key, async () => {
    const logo = badge.path ? await readReactionAsset('logo-library', badge.path) : await readBuiltinReactionBadge();
    return renderScreenControlParticipantCard(await readBackground(), logo, card);
  });
}
