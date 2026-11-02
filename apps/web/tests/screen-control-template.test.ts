import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { cachedScreenControlImage, renderScreenControlImage } from '../src/lib/screen-control-render';
import {
  resolveScreenText, SCREEN_SAMPLE_VALUES, ScreenImageTemplateSchema, screenTemplateFields,
  unsupportedScreenFields, type ScreenImageTemplate, type ScreenTextBlock,
} from '../src/lib/screen-control-template';
import { UpdateScreenControlGroupSchema } from '../src/lib/screen-control-policy';

const block: ScreenTextBlock = {
  id: 'name', content: '姓名：<name>\n学校：<school>', x: 20, y: 30, width: 60, height: 35,
  fontSize: 48, fontFamily: 'SANS', alignment: 'center', color: '#111111', bold: true,
};
const layout = (patch: Partial<ScreenTextBlock> = {}): ScreenImageTemplate => ({ version: 1, blocks: [{ ...block, ...patch }] });
const source = () => sharp({ create: { width: 640, height: 360, channels: 3, background: '#ffffff' } }).webp().toBuffer();

test('template schema bounds boxes, counts, colors, identifiers and supported contest fields', () => {
  assert.equal(ScreenImageTemplateSchema.safeParse(layout()).success, true);
  for (const patch of [{ x: 70 }, { y: 80 }, { width: 0 }, { height: -1 }, { fontSize: 1000 }, { color: 'url(http://example.com)' }]) {
    assert.equal(ScreenImageTemplateSchema.safeParse(layout(patch)).success, false);
  }
  assert.equal(ScreenImageTemplateSchema.safeParse({ version: 1, blocks: [block, block] }).success, false);
  assert.equal(ScreenImageTemplateSchema.safeParse({ version: 1, blocks: Array.from({ length: 21 }, (_, i) => ({ ...block, id: String(i) })) }).success, false);
  assert.deepEqual(screenTemplateFields(false).map(field => field.label), ['姓名', '学校', '学院', '组别']);
  assert.deepEqual(screenTemplateFields(true).map(field => field.label), ['队伍名称', '队伍成员', '学校', '学院', '组别']);
  assert.deepEqual(unsupportedScreenFields(layout({ content: '<teamname> <members>' }), false), ['<teamname>', '<members>']);
  assert.deepEqual(unsupportedScreenFields(layout({ content: '<teamname> <members> <school> <college> <group>' }), true), []);
  assert.equal(UpdateScreenControlGroupSchema.safeParse({ templates: [{ imageId: 'a', template: layout() }] }).success, true);
  assert.equal(UpdateScreenControlGroupSchema.safeParse({ templates: [] }).success, false);
});

test('field substitution preserves literal candidate text and leaves missing values empty', () => {
  assert.equal(resolveScreenText('<name> / <school>', { ...SCREEN_SAMPLE_VALUES, name: '<school>&张三', school: '' }), '<school>&张三 / ');
});

test('Chinese text, multiline names and markup-like candidate data render inside the selected box', async () => {
  const background = await source();
  for (const template of [layout(), layout({ content: '<members>', alignment: 'right', fontFamily: 'SERIF', fontSize: 160, width: 12, height: 8 })]) {
    const result = await renderScreenControlImage(background, template, {
      ...SCREEN_SAMPLE_VALUES, name: '张三 & <school>', members: Array(40).fill('李四与王五<&>算法队').join('、'),
    });
    const { data, info } = await sharp(result).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 640); assert.equal(info.height, 360);
    const selected = template.blocks[0];
    let darkPixels = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset] < 180 && data[offset + 1] < 180 && data[offset + 2] < 180) {
        darkPixels++;
        assert.ok(x >= info.width * selected.x / 100 - 2 && x <= info.width * (selected.x + selected.width) / 100 + 2);
        assert.ok(y >= info.height * selected.y / 100 - 2 && y <= info.height * (selected.y + selected.height) / 100 + 2);
      }
    }
    assert.ok(darkPixels > 0, 'text must be present, including when a long team list is auto-fitted');
    assert.ok(result.length <= 10 * 1024 * 1024);
  }
});

test('images without text retain original bytes and personalized cache keys include all candidate values', async () => {
  const background = await source();
  assert.deepEqual(await renderScreenControlImage(background, { version: 1, blocks: [] }, SCREEN_SAMPLE_VALUES), background);
  assert.deepEqual(await renderScreenControlImage(background, layout({ content: '<name>' }), { ...SCREEN_SAMPLE_VALUES, name: '' }), background);
  let reads = 0;
  const read = async () => { reads++; return background; };
  const image = { objectPath: `screen-control/cache-test-${Date.now()}` };
  const values = { ...SCREEN_SAMPLE_VALUES, name: '李四' };
  const [one, repeat] = await Promise.all([
    cachedScreenControlImage(image, layout(), SCREEN_SAMPLE_VALUES, read),
    cachedScreenControlImage(image, layout(), SCREEN_SAMPLE_VALUES, read),
  ]);
  assert.equal(reads, 1);
  assert.deepEqual(one, repeat);
  const another = await cachedScreenControlImage(image, layout(), values, read);
  assert.notDeepEqual(one, another);
  assert.equal(reads, 2);
});
