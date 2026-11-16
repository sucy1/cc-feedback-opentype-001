// Font subsetting.
//
// The subsetter works on the *raw* table bytes captured while parsing the
// font (see `font._rawTables` in opentype.mjs). The glyf blocks of the
// selected glyphs are copied verbatim so the rendered outlines stay
// identical to the original font; composite glyph references are rewritten
// to the subset's glyph ids, and every table that depends on glyph ids is
// regenerated.
//
// Only TrueType outlines (the `glyf`/`loca` pair) are supported. CFF-based
// OTF fonts have no glyf table and are rejected explicitly.

import table from './table.mjs';
import cmap from './tables/cmap.mjs';
import { standardNames } from './encoding.mjs';

const SFNT_VERSION = new Uint8Array([0x00, 0x01, 0x00, 0x00]);

function ushort(v) {
    return [(v >> 8) & 0xFF, v & 0xFF];
}

function ulong(v) {
    return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
}

// Read a big-endian unsigned 16-bit value from a byte array.
function readU16(bytes, offset) {
    return ((bytes[offset] & 0xFF) << 8) | (bytes[offset + 1] & 0xFF);
}

// Read a big-endian signed 16-bit value from a byte array.
function readS16(bytes, offset) {
    const v = readU16(bytes, offset);
    return v >= 0x8000 ? v - 0x10000 : v;
}

// Read a big-endian unsigned 32-bit value from a byte array.
function readU32(bytes, offset) {
    return (((bytes[offset] & 0xFF) << 24) |
        ((bytes[offset + 1] & 0xFF) << 16) |
        ((bytes[offset + 2] & 0xFF) << 8) |
        (bytes[offset + 3] & 0xFF)) >>> 0;
}

function log2(v) {
    return Math.log(v) / Math.log(2) | 0;
}

// Locate a table's raw bytes in the font's parsed table directory.
function getRawTable(font, tag) {
    const raw = font._rawTables && font._rawTables[tag];
    if (!raw) {
        throw new Error('Font is missing required table "' + tag + '" for subsetting.');
    }

    return raw;
}

// Recursively collect all glyph ids a glyph depends on.
// The glyph itself is added first, so the resulting order keeps parents
// before the components they reference. Circular references are skipped:
// every member of the cycle is still included through another path.
function collectGlyphs(font, rootIds) {
    const ordered = [];
    const seen = new Set();
    const stack = [];

    function visit(gid) {
        if (seen.has(gid)) {
            return;
        }

        seen.add(gid);
        ordered.push(gid);
        const glyph = font.glyphs.get(gid);
        // Accessing .path forces the lazy ttf glyph loader to parse the
        // glyf block and populate `components` for composite glyphs.
        glyph.path;
        if (glyph.isComposite && glyph.components) {
            for (let i = 0; i < glyph.components.length; i += 1) {
                stack.push(glyph.components[i].glyphIndex);
            }
        }
    }

    for (let i = 0; i < rootIds.length; i += 1) {
        visit(rootIds[i]);
    }

    while (stack.length > 0) {
        visit(stack.pop());
    }

    return ordered;
}

// Return a copy of a glyf block with every composite component glyph id
// remapped through `idMap` (old gid -> new gid). Simple glyphs and empty
// glyphs pass through untouched.
function remapGlyfBlock(bytes, start, end, idMap) {
    const numberOfContours = readS16(bytes, start);
    if (numberOfContours >= 0) {
        // Simple glyph (0 contours means an empty glyph): nothing references
        // another glyph id, keep the original bytes verbatim.
        return bytes.slice(start, end);
    }

    const block = Array.prototype.slice.call(bytes, start, end);
    // Bounding box (4 x int16) sits between the contour count and the flags.
    let offset = start + 10;
    let moreComponents = true;
    while (moreComponents) {
        const flags = readU16(bytes, offset);
        const componentIndexOffset = offset - start + 2;
        const oldGid = readU16(block, componentIndexOffset);
        const newGid = idMap[oldGid];
        if (newGid === undefined) {
            throw new Error('Composite glyph references glyph ' + oldGid +
                ' which was not included in the subset.');
        }

        const encoded = ushort(newGid);
        block[componentIndexOffset] = encoded[0];
        block[componentIndexOffset + 1] = encoded[1];

        // ARG_1_AND_2_ARE_WORDS (bit 0): arguments are two int16/uint16
        // values when set, two int8/uint8 values otherwise.
        const argumentSize = flags & 1 ? 4 : 2;

        let transformSize = 0;
        if (flags & 8) {
            // WE_HAVE_A_SCALE: one F2Dot14.
            transformSize = 2;
        } else if (flags & 64) {
            // WE_HAVE_AN_X_AND_Y_SCALE: two F2Dot14.
            transformSize = 4;
        } else if (flags & 128) {
            // WE_HAVE_A_TWO_BY_TWO: four F2Dot14.
            transformSize = 8;
        }

        offset += 4 + argumentSize + transformSize;
        moreComponents = !!(flags & 32);
    }

    return block;
}

// Build the subset `glyf` table (raw bytes), the matching `loca` offsets and
// the global font bounding box across the retained glyphs.
function buildGlyfAndLoca(blocks) {
    const glyfBytes = [];
    const offsets = [0];
    let xMin = 0;
    let yMin = 0;
    let xMax = 0;
    let yMax = 0;
    let hasBBox = false;

    for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i];
        if (block.length > 0) {
            // Every non-empty glyf block starts with a contour count and a
            // bounding box.
            const gxMin = readS16(block, 2);
            const gyMin = readS16(block, 4);
            const gxMax = readS16(block, 6);
            const gyMax = readS16(block, 8);
            if (!hasBBox) {
                xMin = gxMin;
                yMin = gyMin;
                xMax = gxMax;
                yMax = gyMax;
                hasBBox = true;
            } else {
                xMin = Math.min(xMin, gxMin);
                yMin = Math.min(yMin, gyMin);
                xMax = Math.max(xMax, gxMax);
                yMax = Math.max(yMax, gyMax);
            }

            for (let j = 0; j < block.length; j += 1) {
                glyfBytes.push(block[j]);
            }

            // Each glyph block must start on an even offset so its int16
            // header stays aligned.
            if (block.length % 2 !== 0) {
                glyfBytes.push(0);
            }
        }

        offsets.push(glyfBytes.length);
    }

    return {
        glyfBytes: glyfBytes,
        offsets: offsets,
        bbox: {xMin: xMin, yMin: yMin, xMax: xMax, yMax: yMax}
    };
}

// Encode the loca table in its short (uint16 half-offsets) or long (uint32
// full offsets) version.
function makeLocaTable(offsets, longFormat) {
    const fields = [];
    if (longFormat) {
        for (let i = 0; i < offsets.length; i += 1) {
            fields.push({name: 'offset_' + i, type: 'ULONG', value: offsets[i]});
        }
    } else {
        for (let i = 0; i < offsets.length; i += 1) {
            fields.push({name: 'offset_' + i, type: 'USHORT', value: offsets[i] / 2});
        }
    }

    return new table.Table('loca', fields);
}

// Rebuild hmtx with run-length compression of trailing glyphs that share the
// same advance width, exactly as the OpenType spec prescribes: the first
// numberOfHMetrics glyphs carry (advanceWidth, lsb), the remaining glyphs
// carry their lsb only.
function makeHmtxTable(metrics) {
    let numberOfHMetrics = metrics.length;
    while (numberOfHMetrics > 1 &&
        metrics[numberOfHMetrics - 1].advanceWidth === metrics[numberOfHMetrics - 2].advanceWidth) {
        numberOfHMetrics -= 1;
    }

    const fields = [];
    for (let i = 0; i < numberOfHMetrics; i += 1) {
        fields.push({name: 'advanceWidth_' + i, type: 'USHORT', value: metrics[i].advanceWidth});
        fields.push({name: 'leftSideBearing_' + i, type: 'SHORT', value: metrics[i].leftSideBearing});
    }

    for (let i = numberOfHMetrics; i < metrics.length; i += 1) {
        fields.push({name: 'leftSideBearingTail_' + i, type: 'SHORT', value: metrics[i].leftSideBearing});
    }

    return {
        table: new table.Table('hmtx', fields),
        numberOfHMetrics: numberOfHMetrics
    };
}

// Build a version 2 `post` table carrying explicit names for every retained
// glyph. Version 3 would parse correctly too, but carries no names at all;
// the explicit names guarantee round-tripped glyph names never come out
// garbled or missing.
function makePostTable(font, orderedIds) {
    const names = [];
    for (let i = 0; i < orderedIds.length; i += 1) {
        const gid = orderedIds[i];
        let name = null;
        if (font.glyphNames && font.glyphNames.glyphIndexToName) {
            name = font.glyphNames.glyphIndexToName(gid);
        }

        if (!name) {
            name = 'gid' + gid;
        }

        names.push(name);
    }

    // Ensure the first glyph keeps the conventional .notdef name.
    names[0] = '.notdef';

    const sourcePost = font.tables.post || {};
    const fields = [
        {name: 'version', type: 'FIXED', value: 0x00020000},
        {name: 'italicAngle', type: 'FIXED',
            value: Math.round((sourcePost.italicAngle || 0) * 0x10000)},
        {name: 'underlinePosition', type: 'FWORD', value: sourcePost.underlinePosition || 0},
        {name: 'underlineThickness', type: 'FWORD', value: sourcePost.underlineThickness || 0},
        {name: 'isFixedPitch', type: 'ULONG', value: sourcePost.isFixedPitch || 0},
        {name: 'minMemType42', type: 'ULONG', value: sourcePost.minMemType42 || 0},
        {name: 'maxMemType42', type: 'ULONG', value: sourcePost.maxMemType42 || 0},
        {name: 'minMemType1', type: 'ULONG', value: sourcePost.minMemType1 || 0},
        {name: 'maxMemType1', type: 'ULONG', value: sourcePost.maxMemType1 || 0},
        {name: 'numberOfGlyphs', type: 'USHORT', value: names.length}
    ];

    // Standard Macintosh names are referenced by their index; any other name
    // is appended to the table's Pascal-string pool.
    const customNames = [];
    const customIndexByName = {};

    for (let i = 0; i < names.length; i += 1) {
        const standardIndex = standardNames.indexOf(names[i]);
        if (standardIndex >= 0) {
            fields.push({name: 'glyphNameIndex_' + i, type: 'USHORT', value: standardIndex});
        } else if (customIndexByName[names[i]] !== undefined) {
            fields.push({name: 'glyphNameIndex_' + i, type: 'USHORT',
                value: 258 + customIndexByName[names[i]]});
        } else {
            customIndexByName[names[i]] = customNames.length;
            customNames.push(names[i]);
            fields.push({name: 'glyphNameIndex_' + i, type: 'USHORT',
                value: 258 + customNames.length - 1});
        }
    }

    for (let i = 0; i < customNames.length; i += 1) {
        const nameString = customNames[i];
        if (nameString.length > 255) {
            throw new Error('Glyph name "' + nameString + '" is too long for a post table.');
        }

        const nameBytes = [nameString.length];
        for (let j = 0; j < nameString.length; j += 1) {
            nameBytes.push(nameString.charCodeAt(j) & 0xFF);
        }

        fields.push({name: 'customName_' + i, type: 'LITERAL', value: nameBytes});
    }

    return new table.Table('post', fields);
}

// Minimal glyph-like object, just enough of the Glyph interface for the
// shared cmap table builder (it reads glyph.unicodes and the glyph count).
function FakeGlyph(unicodes) {
    this.unicodes = unicodes;
    this.unicode = unicodes.length > 0 ? unicodes[0] : undefined;
}

function FakeGlyphSet(glyphs) {
    this.glyphs = glyphs;
    this.length = glyphs.length;
}

FakeGlyphSet.prototype.get = function(index) {
    return this.glyphs[index];
};

// Build the subset cmap (format 4, plus format 12 when any codepoint is
// outside the BMP). Only the requested codepoints are mapped; every other
// character resolves to glyph 0 through the absence of a mapping.
function makeSubsetCmapTable(unicodesByNewGid) {
    const fakeGlyphs = [];
    for (let i = 0; i < unicodesByNewGid.length; i += 1) {
        fakeGlyphs.push(new FakeGlyph(unicodesByNewGid[i]));
    }

    return cmap.make(new FakeGlyphSet(fakeGlyphs));
}

// Patch 16-bit fields in a copy of a raw table. Each patch is
// [byteOffset, value]; values are encoded as unsigned 16-bit (the same
// encoding covers signed int16 after masking), matching the head/hhea/maxp
// fields being rewritten here.
function patchRawTable(rawTable, patches) {
    const bytes = rawTable.slice();
    for (let i = 0; i < patches.length; i += 1) {
        const offset = patches[i][0];
        const value = patches[i][1];
        const encoded = ushort(value & 0xFFFF);
        bytes[offset] = encoded[0];
        bytes[offset + 1] = encoded[1];
    }

    return bytes;
}

// Compute the OpenType table checksum (big-endian uint32 sum over the table
// padded to a multiple of four bytes).
function tableChecksum(bytes) {
    const paddedLength = (bytes.length + 3) & ~3;
    let sum = 0;
    for (let i = 0; i < paddedLength; i += 4) {
        const word =
            (((bytes[i] || 0) & 0xFF) << 24) |
            (((bytes[i + 1] || 0) & 0xFF) << 16) |
            (((bytes[i + 2] || 0) & 0xFF) << 8) |
            ((bytes[i + 3] || 0) & 0xFF);
        sum = (sum + (word >>> 0)) >>> 0;
    }

    return sum >>> 0;
}

// Assemble the final sfnt binary from the encoded table list.
function packSfnt(tables) {
    const encoded = [];
    for (let i = 0; i < tables.length; i += 1) {
        const t = tables[i];
        encoded.push({tag: t.tableName, bytes: t.encode()});
    }

    // Table records must be sorted alphabetically by tag.
    encoded.sort((a, b) => (a.tag < b.tag ? -1 : 1));

    const numTables = encoded.length;
    let highestPowerOf2 = 1;
    while (highestPowerOf2 * 2 <= numTables) {
        highestPowerOf2 *= 2;
    }

    const searchRange = highestPowerOf2 * 16;
    const entrySelector = log2(highestPowerOf2);
    const rangeShift = numTables * 16 - searchRange;

    const header = []
        .concat(Array.prototype.slice.call(SFNT_VERSION))
        .concat(ushort(numTables))
        .concat(ushort(searchRange))
        .concat(ushort(entrySelector))
        .concat(ushort(rangeShift));

    const dataStart = 12 + numTables * 16;
    let dataOffset = dataStart;
    const tableData = [];
    const records = [];
    for (let i = 0; i < encoded.length; i += 1) {
        const entry = encoded[i];
        const length = entry.bytes.length;
        const checksum = tableChecksum(entry.bytes);
        records.push({
            tag: entry.tag,
            checksum: checksum,
            offset: dataOffset,
            length: length
        });
        tableData.push(entry.bytes);
        dataOffset += (length + 3) & ~3;
    }

    const totalLength = dataOffset;
    const out = new Uint8Array(totalLength);
    let pos = 0;
    for (let i = 0; i < header.length; i += 1) {
        out[pos++] = header[i];
    }

    for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        for (let j = 0; j < 4; j += 1) {
            out[pos++] = record.tag.charCodeAt(j) & 0xFF;
        }

        const checksumBytes = ulong(record.checksum);
        const offsetBytes = ulong(record.offset);
        const lengthBytes = ulong(record.length);
        for (let j = 0; j < 4; j += 1) {
            out[pos++] = checksumBytes[j];
        }

        for (let j = 0; j < 4; j += 1) {
            out[pos++] = offsetBytes[j];
        }

        for (let j = 0; j < 4; j += 1) {
            out[pos++] = lengthBytes[j];
        }
    }

    let headTableIndex = -1;
    for (let i = 0; i < records.length; i += 1) {
        if (records[i].tag === 'head') {
            headTableIndex = i;
            break;
        }
    }

    if (headTableIndex < 0) {
        throw new Error('Subset font is missing the head table.');
    }

    for (let i = 0; i < tableData.length; i += 1) {
        const bytes = tableData[i];
        for (let j = 0; j < bytes.length; j += 1) {
            out[pos++] = bytes[j];
        }

        // Pad to a 4-byte boundary.
        while (pos % 4 !== 0) {
            out[pos++] = 0;
        }
    }

    // head.checkSumAdjustment (head table offset 4) makes the whole-font
    // checksum sum to 0xB1B0AFBA. Compute it over the complete binary with
    // the field zeroed; the magicNumber field at offset 8 stays untouched.
    const headOffset = records[headTableIndex].offset;
    out[headOffset + 4] = 0;
    out[headOffset + 5] = 0;
    out[headOffset + 6] = 0;
    out[headOffset + 7] = 0;
    const wholeChecksum = tableChecksum(out);
    const adjustment = (0xB1B0AFBA - wholeChecksum) >>> 0;
    const adjustmentBytes = ulong(adjustment);
    for (let j = 0; j < 4; j += 1) {
        out[headOffset + 4 + j] = adjustmentBytes[j];
    }

    return out.buffer;
}

// Resolve the requested selection (unicodes and/or glyph names) to original
// glyph ids present in the font.
function resolveRequestedGlyphs(font, options) {
    const rootIds = new Set();

    if (options.unicodes) {
        for (let i = 0; i < options.unicodes.length; i += 1) {
            const codePoint = options.unicodes[i];
            const gid = font.charToGlyphIndex(String.fromCodePoint(codePoint));
            if (gid > 0) {
                rootIds.add(gid);
            }
        }
    }

    if (options.glyphNames) {
        for (let i = 0; i < options.glyphNames.length; i += 1) {
            const gid = font.nameToGlyphIndex(options.glyphNames[i]);
            if (gid > 0) {
                rootIds.add(gid);
            }
        }
    }

    return Array.from(rootIds);
}

/**
 * Create a subset of the font containing only the requested glyphs.
 *
 * Only fonts with TrueType (`glyf`) outlines are supported. The returned
 * ArrayBuffer is a complete sfnt font that can be fed back into
 * `opentype.parse()`.
 *
 * @param {Object} options
 * @param {number[]} [options.unicodes] - Unicode codepoints to keep, e.g. [0x41, 0x42]
 * @param {string[]} [options.glyphNames] - glyph names to keep
 * @return {ArrayBuffer} the subsetted font
 */
function subsetFont(font, options) {
    options = options || {};

    if (font.outlinesFormat !== 'truetype' || !font._rawTables || !font._rawTables.glyf) {
        throw new Error('subset supports TrueType outlines only.');
    }

    const rootIds = resolveRequestedGlyphs(font, options);
    if (rootIds.length === 0) {
        throw new Error('subset: no glyphs selected.');
    }

    // .notdef is always glyph 0 and always retained, in first position.
    const orderedIds = [0].concat(collectGlyphs(font, rootIds));
    const idMap = [];
    for (let i = 0; i < orderedIds.length; i += 1) {
        idMap[orderedIds[i]] = i;
    }

    const glyfRaw = getRawTable(font, 'glyf');
    const locaRaw = getRawTable(font, 'loca');
    const longLoca = font.tables.head.indexToLocFormat === 1;

    // Parse the original loca offsets to find each glyph's glyf block bounds.
    const originalOffsets = [];
    if (longLoca) {
        for (let i = 0; i < font.numGlyphs + 1; i += 1) {
            originalOffsets.push(readU32(locaRaw, i * 4));
        }
    } else {
        for (let i = 0; i < font.numGlyphs + 1; i += 1) {
            originalOffsets.push(readU16(locaRaw, i * 2) * 2);
        }
    }

    // Build the new glyf data, copying each retained block (with remapped
    // component ids) and recomputing every loca offset.
    const blocks = [];
    for (let i = 0; i < orderedIds.length; i += 1) {
        const oldGid = orderedIds[i];
        const start = originalOffsets[oldGid];
        const end = originalOffsets[oldGid + 1];
        blocks.push(remapGlyfBlock(glyfRaw, start, end, idMap));
    }

    const glyfAndLoca = buildGlyfAndLoca(blocks);
    const newOffsets = glyfAndLoca.offsets;

    // Use the long loca format whenever an offset does not fit the short
    // (half-offset) representation. All glyf blocks are word aligned, so the
    // only overflow condition is the 16-bit size of the short format.
    const useLongLoca = glyfAndLoca.glyfBytes.length > 0x1FFFE;

    const glyfTable = new table.Table('glyf', [
        {name: 'data', type: 'LITERAL', value: glyfAndLoca.glyfBytes}
    ]);
    const locaTable = makeLocaTable(newOffsets, useLongLoca);

    // head layout: version(4) checkSumAdjustment(4) magic(4) flags(2)
    // unitsPerEm(2) created(8) modified(8) xMin(2@36) yMin(2@38) xMax(2@40)
    // yMax(2@42) ... indexToLocFormat(2@50). Keep every other original field
    // intact; checkSumAdjustment is recomputed at pack time.
    const headRaw = getRawTable(font, 'head');
    const headBytes = patchRawTable(headRaw, [
        [36, glyfAndLoca.bbox.xMin],
        [38, glyfAndLoca.bbox.yMin],
        [40, glyfAndLoca.bbox.xMax],
        [42, glyfAndLoca.bbox.yMax],
        [50, useLongLoca ? 1 : 0]
    ]);
    // head.checkSumAdjustment is recomputed over the whole font at pack time,
    // so zero it now: the head table's own record checksum is defined over
    // the bytes with this field zeroed (matching sfnt.mjs's convention).
    headBytes[4] = 0;
    headBytes[5] = 0;
    headBytes[6] = 0;
    headBytes[7] = 0;
    const headTable = new table.Table('head', [
        {name: 'data', type: 'LITERAL', value: Array.prototype.slice.call(headBytes)}
    ]);

    // maxp: only the glyph count changes.
    const maxpRaw = getRawTable(font, 'maxp');
    const maxpBytes = patchRawTable(maxpRaw, [[4, orderedIds.length]]);
    const maxpTable = new table.Table('maxp', [
        {name: 'data', type: 'LITERAL', value: Array.prototype.slice.call(maxpBytes)}
    ]);

    // hhea: only numberOfHMetrics changes; everything else is preserved.
    const hheaRaw = getRawTable(font, 'hhea');
    const hmtxRaw = getRawTable(font, 'hmtx');
    const oldNumberOfHMetrics = font.numberOfHMetrics;
    // Glyphs past the long metrics share the advance width of the last long
    // metric entry, which is always present (numberOfHMetrics >= 1).
    const tailAdvanceWidth = readU16(hmtxRaw, (oldNumberOfHMetrics - 1) * 4);
    const metrics = [];
    for (let i = 0; i < orderedIds.length; i += 1) {
        const oldGid = orderedIds[i];
        let advanceWidth;
        let leftSideBearing;
        if (oldGid < oldNumberOfHMetrics) {
            const entryOffset = oldGid * 4;
            advanceWidth = readU16(hmtxRaw, entryOffset);
            leftSideBearing = readS16(hmtxRaw, entryOffset + 2);
        } else {
            // Trailing glyphs only carry their own left side bearing and
            // reuse the last explicit advance width.
            const lsbOffset = oldNumberOfHMetrics * 4 +
                (oldGid - oldNumberOfHMetrics) * 2;
            advanceWidth = tailAdvanceWidth;
            leftSideBearing = readS16(hmtxRaw, lsbOffset);
        }

        metrics.push({advanceWidth: advanceWidth, leftSideBearing: leftSideBearing});
    }

    const hmtxResult = makeHmtxTable(metrics);
    const hheaBytes = patchRawTable(hheaRaw, [[34, hmtxResult.numberOfHMetrics]]);
    const hheaTable = new table.Table('hhea', [
        {name: 'data', type: 'LITERAL', value: Array.prototype.slice.call(hheaBytes)}
    ]);

    // cmap: regenerate from the requested codepoints against the new gids.
    const cmapGlyphIndexMap = font.tables.cmap.glyphIndexMap;
    const unicodesByNewGid = [];
    for (let i = 0; i < orderedIds.length; i += 1) {
        unicodesByNewGid.push([]);
    }

    const requestedUnicodes = new Set(options.unicodes || []);
    const requestedNameGids = new Set();
    if (options.glyphNames) {
        for (let i = 0; i < options.glyphNames.length; i += 1) {
            const gid = font.nameToGlyphIndex(options.glyphNames[i]);
            if (gid > 0) {
                requestedNameGids.add(gid);
            }
        }
    }

    const codePointKeys = Object.keys(cmapGlyphIndexMap);
    for (let i = 0; i < codePointKeys.length; i += 1) {
        const codePoint = parseInt(codePointKeys[i], 10);
        const oldGid = cmapGlyphIndexMap[codePointKeys[i]];
        if (oldGid === 0 || idMap[oldGid] === undefined) {
            continue;
        }

        // Keep a mapping only when the codepoint (or a glyph selected by
        // name) was explicitly requested.
        if (requestedUnicodes.has(codePoint) || requestedNameGids.has(oldGid)) {
            unicodesByNewGid[idMap[oldGid]].push(codePoint);
        }
    }

    const cmapTable = makeSubsetCmapTable(unicodesByNewGid);
    const postTable = makePostTable(font, orderedIds);

    // Tables unrelated to glyph ids are carried over byte-for-byte.
    const passthroughTags = ['name', 'OS/2'];
    const passthroughTables = [];
    for (let i = 0; i < passthroughTags.length; i += 1) {
        const tag = passthroughTags[i];
        if (font._rawTables[tag]) {
            passthroughTables.push(new table.Table(tag, [
                {name: 'data', type: 'LITERAL',
                    value: Array.prototype.slice.call(font._rawTables[tag])}
            ]));
        }
    }

    const tables = [headTable, hheaTable, maxpTable, cmapTable, postTable,
        hmtxResult.table, glyfTable, locaTable].concat(passthroughTables);

    return packSfnt(tables);
}

export default subsetFont;
