import assert from 'assert';
import { readFileSync } from 'fs';
import { parse } from '../src/opentype.mjs';

const loadSync = (url, opt) => parse(readFileSync(url), opt);
const FONT_PATH = './test/fonts/Changa-Regular.ttf';
const EMOJI_FONT_PATH = './test/fonts/noto-emoji.ttf';
const CFF_FONT_PATH = './test/fonts/AbrilFatface-Regular.otf';
const CIRCULAR_FONT_PATH = './test/fonts/circular-composite.ttf';

describe('font.subset()', function() {
    let font;

    beforeEach(function() {
        font = loadSync(FONT_PATH);
    });

    it('keeps .notdef plus exactly the selected glyphs for a single codepoint', function() {
        const subsetFont = parse(font.subset({unicodes: [0x41]}));
        assert.equal(subsetFont.numGlyphs, 2);
        assert.equal(subsetFont.glyphs.get(0).name, '.notdef');
        assert.ok(subsetFont.charToGlyph('A').index > 0);
        assert.equal(subsetFont.charToGlyph('Z').index, 0);
    });

    it('subsets multiple codepoints and remaps the cmap to the new glyph ids', function() {
        const subsetFont = parse(font.subset({unicodes: [0x41, 0x42, 0x43]}));
        assert.equal(subsetFont.numGlyphs, 4);
        assert.equal(subsetFont.charToGlyphIndex('A'), 1);
        assert.equal(subsetFont.charToGlyphIndex('B'), 2);
        assert.equal(subsetFont.charToGlyphIndex('C'), 3);
        // Unrequested characters fall back to .notdef (glyph 0).
        assert.equal(subsetFont.charToGlyphIndex('Z'), 0);
        assert.equal(subsetFont.charToGlyphIndex('a'), 0);
    });

    it('accepts glyph names as an alternative selection', function() {
        const subsetFont = parse(font.subset({glyphNames: ['A', 'B']}));
        assert.equal(subsetFont.numGlyphs, 3);
        assert.ok(subsetFont.charToGlyphIndex('A') > 0);
        assert.ok(subsetFont.charToGlyphIndex('B') > 0);
    });

    it('accepts unicodes and glyph names together', function() {
        const subsetFont = parse(font.subset({unicodes: [0x43], glyphNames: ['D']}));
        assert.equal(subsetFont.numGlyphs, 3);
        assert.ok(subsetFont.charToGlyphIndex('C') > 0);
        assert.ok(subsetFont.charToGlyphIndex('D') > 0);
    });

    it('recursively includes composite glyph components and remaps their ids', function() {
        // é (U+00E9) is a composite of e + acutecomb (+ .ttfautohint).
        const eacuteGid = font.charToGlyphIndex('é');
        const originalEacute = font.glyphs.get(eacuteGid);
        originalEacute.path;
        assert.ok(originalEacute.isComposite);
        const componentNames = originalEacute.components.map(c => font.glyphs.get(c.glyphIndex).name);

        const subsetFont = parse(font.subset({unicodes: [0xE9]}));
        assert.ok(subsetFont.numGlyphs > 2, 'components must be retained');

        const subsetEacute = subsetFont.charToGlyph('é');
        subsetEacute.path;
        assert.ok(subsetEacute.isComposite);
        // Every component id must point inside the subset, never to an old id.
        for (const component of subsetEacute.components) {
            assert.ok(component.glyphIndex < subsetFont.numGlyphs);
        }

        const subsetComponentNames = subsetEacute.components.map(
            c => subsetFont.glyphs.get(c.glyphIndex).name);
        assert.deepEqual(subsetComponentNames.sort(), componentNames.slice().sort());

        // Without its components the composite would render an empty path.
        assert.ok(subsetFont.getPath('é', 0, 0, 100).toPathData(2).length > 0);
    });

    it('produces outlines identical to the original glyphs', function() {
        const unicodes = [0x41, 0x42, 0x43, 0x61, 0x62, 0xE9];
        const subsetFont = parse(font.subset({unicodes: unicodes}));
        for (const codePoint of unicodes) {
            const ch = String.fromCodePoint(codePoint);
            const expected = font.getPath(ch, 0, 0, 100).toPathData(2);
            const actual = subsetFont.getPath(ch, 0, 0, 100).toPathData(2);
            assert.equal(actual, expected, 'path mismatch for U+' + codePoint.toString(16));
        }
    });

    it('throws when no codepoint is selected', function() {
        assert.throws(() => font.subset({unicodes: []}),
            /no glyphs selected/);
    });

    it('throws when none of the requested codepoints are covered by the font', function() {
        assert.throws(() => font.subset({unicodes: [0xF0000]}),
            /no glyphs selected/);
    });

    it('throws when called without any selection', function() {
        assert.throws(() => font.subset(),
            /no glyphs selected/);
    });

    it('rejects CFF/OTF fonts with an explicit error', function() {
        const cffFont = loadSync(CFF_FONT_PATH);
        assert.throws(() => cffFont.subset({unicodes: [0x41]}),
            /subset supports TrueType outlines only/);
    });

    it('preserves every retained glyph advance width and left side bearing', function() {
        // Use a freshly parsed reference and derive the expected metrics from
        // the raw hmtx table, since the parser reuses the last advance width
        // for tail glyphs and glyph objects can be lazily mutated elsewhere.
        const referenceFont = loadSync(FONT_PATH);
        const hmtx = referenceFont._rawTables.hmtx;
        const numberOfHMetrics = referenceFont.numberOfHMetrics;
        const tailAdvanceWidth = (hmtx[(numberOfHMetrics - 1) * 4] << 8) |
            hmtx[(numberOfHMetrics - 1) * 4 + 1];

        function expectedMetrics(oldGid) {
            if (oldGid < numberOfHMetrics) {
                const offset = oldGid * 4;
                const rawLsb = (hmtx[offset + 2] << 8) | hmtx[offset + 3];
                return {
                    advanceWidth: (hmtx[offset] << 8) | hmtx[offset + 1],
                    leftSideBearing: rawLsb >= 0x8000 ? rawLsb - 0x10000 : rawLsb
                };
            }

            const lsbOffset = numberOfHMetrics * 4 +
                (oldGid - numberOfHMetrics) * 2;
            const rawLsb = (hmtx[lsbOffset] << 8) | hmtx[lsbOffset + 1];
            return {
                advanceWidth: tailAdvanceWidth,
                leftSideBearing: rawLsb >= 0x8000 ? rawLsb - 0x10000 : rawLsb
            };
        }

        const subsetFont = parse(font.subset({unicodes: [0x41, 0xE9]}));
        for (let i = 0; i < subsetFont.numGlyphs; i += 1) {
            const subsetGlyph = subsetFont.glyphs.get(i);
            const oldGid = referenceFont.nameToGlyphIndex(subsetGlyph.name);
            const expected = expectedMetrics(oldGid);
            assert.equal(subsetGlyph.advanceWidth, expected.advanceWidth,
                'advanceWidth mismatch for ' + subsetGlyph.name);
            assert.equal(subsetGlyph.leftSideBearing, expected.leftSideBearing,
                'leftSideBearing mismatch for ' + subsetGlyph.name);
        }
    });

    it('writes a consistent hmtx tail and hhea.numberOfHMetrics', function() {
        const subsetFont = parse(font.subset({unicodes: [0x41, 0xE9]}));
        const hmtx = subsetFont._rawTables.hmtx;
        const numberOfHMetrics = subsetFont.numberOfHMetrics;
        // hmtx holds numberOfHMetrics long metrics (4 bytes) plus one int16
        // left side bearing for each remaining glyph.
        assert.equal(hmtx.length,
            numberOfHMetrics * 4 + (subsetFont.numGlyphs - numberOfHMetrics) * 2);
        assert.ok(numberOfHMetrics >= 1);
        assert.ok(numberOfHMetrics <= subsetFont.numGlyphs);
    });

    it('emits a format 4 cmap for BMP-only selections', function() {
        const subsetFont = parse(font.subset({unicodes: [0x41, 0x42, 0x43]}));
        const cmapBytes = subsetFont._rawTables.cmap;
        const numSubtables = (cmapBytes[2] << 8) | cmapBytes[3];
        const formats = [];
        for (let i = 0; i < numSubtables; i += 1) {
            const recordOffset = 4 + i * 8;
            const subtableOffset =
                ((cmapBytes[recordOffset + 4] << 24) |
                 (cmapBytes[recordOffset + 5] << 16) |
                 (cmapBytes[recordOffset + 6] << 8) |
                 cmapBytes[recordOffset + 7]) >>> 0;
            formats.push((cmapBytes[subtableOffset] << 8) | cmapBytes[subtableOffset + 1]);
        }

        assert.ok(formats.includes(4));
        assert.ok(!formats.includes(12));
    });

    it('emits both format 4 and format 12 cmap subtables for astral codepoints', function() {
        const emojiFont = loadSync(EMOJI_FONT_PATH);
        const astral = Object.keys(emojiFont.tables.cmap.glyphIndexMap)
            .map(codePoint => parseInt(codePoint, 10))
            .filter(codePoint => codePoint > 0xFFFF)
            .slice(0, 2);
        assert.ok(astral.length === 2);

        const subsetBuffer = emojiFont.subset({unicodes: astral});
        const subsetFont = parse(subsetBuffer);
        for (const codePoint of astral) {
            assert.ok(subsetFont.charToGlyphIndex(String.fromCodePoint(codePoint)) > 0);
            const ch = String.fromCodePoint(codePoint);
            assert.equal(
                subsetFont.getPath(ch, 0, 0, 100).toPathData(2),
                emojiFont.getPath(ch, 0, 0, 100).toPathData(2));
        }

        const cmapBytes = subsetFont._rawTables.cmap;
        const numSubtables = (cmapBytes[2] << 8) | cmapBytes[3];
        const formats = [];
        for (let i = 0; i < numSubtables; i += 1) {
            const recordOffset = 4 + i * 8;
            const subtableOffset =
                ((cmapBytes[recordOffset + 4] << 24) |
                 (cmapBytes[recordOffset + 5] << 16) |
                 (cmapBytes[recordOffset + 6] << 8) |
                 cmapBytes[recordOffset + 7]) >>> 0;
            formats.push((cmapBytes[subtableOffset] << 8) | cmapBytes[subtableOffset + 1]);
        }

        assert.ok(formats.includes(4));
        assert.ok(formats.includes(12));
    });

    it('keeps head.unitsPerEm and maxp.numGlyphs in sync', function() {
        const unicodes = [0x41, 0x42, 0x43, 0xE9];
        const subsetFont = parse(font.subset({unicodes: unicodes}));
        assert.equal(subsetFont.unitsPerEm, font.unitsPerEm);
        assert.equal(subsetFont.tables.maxp.numGlyphs, subsetFont.numGlyphs);
        assert.equal(subsetFont.tables.head.unitsPerEm, font.unitsPerEm);
    });

    it('round-trips glyph names without garbling them', function() {
        const subsetFont = parse(font.subset({unicodes: [0x41, 0xE9]}));
        assert.equal(subsetFont.nameToGlyphIndex('.notdef'), 0);
        assert.ok(subsetFont.nameToGlyphIndex('A') > 0);
        assert.ok(subsetFont.nameToGlyphIndex('eacute') > 0);
        for (let i = 0; i < subsetFont.numGlyphs; i += 1) {
            assert.equal(typeof subsetFont.glyphs.get(i).name, 'string');
            assert.ok(subsetFont.glyphs.get(i).name.length > 0);
        }
    });

    it('is stable across repeated parse/subset cycles', function() {
        const unicodes = [0x41, 0x42, 0xE9];
        const firstBuffer = font.subset({unicodes: unicodes});
        const firstFont = parse(firstBuffer);
        const secondBuffer = firstFont.subset({unicodes: unicodes});
        const secondFont = parse(secondBuffer);

        assert.equal(secondFont.numGlyphs, firstFont.numGlyphs);
        for (const codePoint of unicodes) {
            const ch = String.fromCodePoint(codePoint);
            assert.equal(firstFont.charToGlyphIndex(ch), secondFont.charToGlyphIndex(ch));
            assert.equal(
                firstFont.getPath(ch, 0, 0, 100).toPathData(2),
                secondFont.getPath(ch, 0, 0, 100).toPathData(2));
        }

        // The regenerated tables must be identical, so repeated subsetting
        // cannot drift between runs.
        for (const tag of Object.keys(firstFont._rawTables).sort()) {
            const first = firstFont._rawTables[tag];
            const second = secondFont._rawTables[tag];
            assert.equal(second.length, first.length, 'table length differs: ' + tag);
            for (let i = 0; i < first.length; i += 1) {
                assert.equal(second[i], first[i], 'table bytes differ: ' + tag);
            }
        }
    });

    it('handles circular composite references without infinite recursion', function() {
        const circularFont = loadSync(CIRCULAR_FONT_PATH);
        const unicodes = Object.keys(circularFont.tables.cmap.glyphIndexMap)
            .map(codePoint => parseInt(codePoint, 10));
        const subsetFont = parse(circularFont.subset({unicodes: unicodes}));
        for (let i = 0; i < subsetFont.numGlyphs; i += 1) {
            subsetFont.glyphs.get(i).path;
        }
    });

    it('returns an ArrayBuffer substantially smaller than the source font', function() {
        const subsetBuffer = font.subset({unicodes: [0x41, 0x42, 0x43]});
        assert.ok(subsetBuffer instanceof ArrayBuffer);
        assert.ok(subsetBuffer.byteLength < readFileSync(FONT_PATH).length / 10);
    });
});
