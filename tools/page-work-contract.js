'use strict';

// checkJs: start
/** @typedef {{type: 'thumb', page: number, id: number, t: number, w: number, h: number, mode?: 'key' | 'near' | 'exact' | 'run', pass?: boolean, cancel?: boolean}} ThumbRequest */
/** @typedef {{type: 'thumb', boot: string, page: number, id: number, w?: number, h?: number, kt?: number|null, rel?: number|null, fmt?: 'jpeg', data?: Uint8Array, next?: {kt: number, rel: number|null, data: Uint8Array}, kn?: null, more?: {kt: number, rel: number|null, data: Uint8Array}[], end?: boolean}} ThumbReply */
/** @typedef {{type: 'exportGrab', boot: string, page: number, id: number, frame: number}} ExportGrab */
// checkJs: end

module.exports = {};
