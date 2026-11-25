import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactionLogoOrganizationName, reactionLogoSelection } from '../src/lib/reaction-render-settings';
import { normalizeReactionOrganizationName, type ReactionBrandingSettings } from '../src/lib/reaction-branding-contract';

const branding: ReactionBrandingSettings = {
  version: 1,
  organizations: [{ name: 'Acme University', logoId: 'organization-logo' }, { name: '测试 大学', logoId: 'chinese-logo' }, { name: '计算机学院', logoId: 'college-logo' }],
  defaultLogoId: 'system-default-logo'
};

test('organization names normalize Unicode width and whitespace without fuzzy matching', () => {
  assert.equal(normalizeReactionOrganizationName('　Ａｃｍｅ\u00a0\tUniversity\n '), 'Acme University');
  assert.equal(normalizeReactionOrganizationName(' 测试　\t大学 '), '测试 大学');
  assert.notEqual(normalizeReactionOrganizationName('A-B University'), normalizeReactionOrganizationName('AB University'));
  assert.notEqual(normalizeReactionOrganizationName('Acme University'), normalizeReactionOrganizationName('acme University'));
});

test('normalized exact organization selects its system logo and records the normalized identity', () => {
  assert.deepEqual(reactionLogoSelection(branding, '　Ａｃｍｅ\tUniversity　'), {
    logoId: 'organization-logo', basis: 'system-organization', organizationName: 'Acme University', normalizedOrganizationName: 'Acme University'
  });
  assert.equal(reactionLogoSelection(branding, '测试 \n 大学').logoId, 'chinese-logo');
});

test('the exam selects only its configured organization field for logo matching', () => {
  const candidate = { school: 'Acme University', college: '　计算机学院 ' };
  assert.equal(reactionLogoSelection(branding, reactionLogoOrganizationName('SCHOOL', candidate)).logoId, 'organization-logo');
  assert.equal(reactionLogoSelection(branding, reactionLogoOrganizationName('COLLEGE', candidate)).logoId, 'college-logo');
  for (const college of [null, '　', '计算机', '其他学院']) {
    const selected = reactionLogoSelection(branding, reactionLogoOrganizationName('COLLEGE', { ...candidate, college }));
    assert.equal(selected.logoId, 'system-default-logo');
  }
});

test('case differences, partial names and unknown organizations use the global default', () => {
  for (const school of ['acme University', 'Acme', 'Acme University Extension', 'Unknown Organization']) {
    assert.deepEqual(reactionLogoSelection(branding, school), {
      logoId: 'system-default-logo', basis: 'system-default', organizationName: null, normalizedOrganizationName: school
    });
  }
});

test('blank or missing school uses the global default without inventing an organization', () => {
  for (const school of [null, '', '  \t　 ']) assert.deepEqual(reactionLogoSelection(branding, school), {
    logoId: 'system-default-logo', basis: 'system-default', organizationName: null, normalizedOrganizationName: null
  });
});

test('without a custom system default the renderer explicitly chooses the built-in badge', () => {
  assert.deepEqual(reactionLogoSelection({ ...branding, defaultLogoId: null }, 'Unknown Organization'), {
    logoId: null, basis: 'built-in-default', organizationName: null, normalizedOrganizationName: 'Unknown Organization'
  });
  assert.equal(reactionLogoSelection({ ...branding, defaultLogoId: null }, 'Acme University').basis, 'system-organization');
});

test('legacy exam, school and team mappings cannot override system branding', () => {
  const withLegacyFields = {
    ...branding,
    teamLogos: [{ teamId: 'team01', logoId: 'legacy-team-logo' }],
    schoolLogos: [{ schoolName: 'Acme University', logoId: 'legacy-school-logo' }],
    defaultLogoPath: 'reactions/legacy/assets/wrong.png'
  };
  assert.equal(reactionLogoSelection(withLegacyFields, 'Acme University').logoId, 'organization-logo');
  assert.equal(reactionLogoSelection(withLegacyFields, 'Unmapped University').logoId, 'system-default-logo');
});
