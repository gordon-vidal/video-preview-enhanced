'use strict';
// The unified viewer's cross-file contract check (docs/notes/player-ui-controller.md, "Contracts"). Never run and
// never loaded: `npm run typecheck` (tools/check-js.js, tsconfig.contracts.json) compiles it with module resolution
// on, so each `require` below is the module's real exported type, and every assignment holds that type to
// media/unified-contracts.d.ts. A module that drifts from a contract (a renamed method, another argument order, a
// message the other side does not know) fails here, in the file that names both sides.

const ProdEngine = require('../media/player-engine-adapter.js');
const ProdHost = require('../media/player-host-adapter.js');
const PlayerUi = require('../media/player-ui.js');
const Unified = require('../media/player-unified.js');
const Session = require('../src/unified-session.js');
const FakeEngine = require('./mockup/fake-engine.js');
const FakeHost = require('./mockup/fake-host.js');

/**
 * @typedef {import('../media/unified-contracts').EngineAdapter} EngineAdapter
 * @typedef {import('../media/unified-contracts').HostAdapter} HostAdapter
 * @typedef {import('../media/unified-contracts').UnifiedControllerApi} UnifiedControllerApi
 * @typedef {import('../media/unified-contracts').PageToHostMessage} PageToHostMessage
 * @typedef {import('../media/unified-contracts').HostToPageMessage} HostToPageMessage
 * @typedef {import('../media/unified-contracts').PageToHostType} PageToHostType
 * @typedef {import('../media/unified-contracts').HostToPageType} HostToPageType
 * @typedef {import('../media/unified-contracts').ClipDescriptor} ClipDescriptor
 * @typedef {import('../media/unified-contracts').TransportCommand} TransportCommand
 * @typedef {import('../media/unified-contracts').TileSizePayload} TileSizePayload
 */

/** A value of any type, for assignments that are only ever compiled. */
const value = /** @type {any} */ (null);

// ---- EngineAdapter: the production adapter and the mockup's fake ----
/** @type {EngineAdapter} */
const prodEngine = /** @type {ReturnType<typeof ProdEngine.create>} */ (value);
/** @type {EngineAdapter} */
const fakeEngine = /** @type {ReturnType<typeof FakeEngine.createFakeEngine>} */ (value);

// ---- HostAdapter: the production adapter and the mockup's fake ----
/** @type {HostAdapter} */
const prodHost = /** @type {ReturnType<typeof ProdHost.create>} */ (value);
/** @type {HostAdapter} */
const fakeHost = /** @type {ReturnType<typeof FakeHost.createFakeHost>} */ (value);

// ---- the controller: what create() returns, and what it accepts ----
/** @type {UnifiedControllerApi} */
const controller = /** @type {ReturnType<typeof PlayerUi.create>} */ (value);
/** Both engines and both hosts are valid `env.engine` / `env.host` of VpePlayerUi.create(). */
/** @type {NonNullable<Parameters<typeof PlayerUi.create>[0]>} */
const env = value;
/** @type {Array<typeof env.engine>} */
const engines = [prodEngine, fakeEngine];
/** @type {Array<typeof env.host>} */
const hosts = [prodHost, fakeHost];
/** The controller reports the transport in TransportCommand, which the page's onTransport takes. */
/** @type {(ev: TransportCommand) => void} */
const onTransport = /** @type {NonNullable<typeof env.onTransport>} */ (value);
/** @type {(ev: TransportCommand) => void} */
const pageTransport = /** @type {ReturnType<typeof Unified.boot>} */ (value).onTransport;

// ---- messages: each side's handler takes the other side's union ----
const session = /** @type {ReturnType<typeof Session.createUnifiedSession>} */ (value);
/** The host's session reads every page message and posts only host messages. */
/** @type {(m: PageToHostMessage) => unknown} */
const hostReads = session.onMessage;
/** @type {HostToPageMessage} */
const hostPosts = /** @type {Parameters<typeof session.post>[0]} */ (value);
/** @type {ClipDescriptor} */
const descriptor = /** @type {ReturnType<typeof Session.clipDescriptor>} */ (value);
/** The page reads every host message, through the adapter's connect() and the controller. */
/** @type {(m: HostToPageMessage) => void} */
const pageReads = /** @type {ReturnType<typeof Unified.boot>} */ (value).onHostMessage;
/** @type {(m: HostToPageMessage) => void} */
const controllerReads = controller.onHostMessage;
/** The names the modules keep as lists are message types of the unions. */
/** @type {PageToHostType} */
const hostCommand = /** @type {typeof PlayerUi.HOST_COMMANDS[number]} */ (value);
/** @type {HostToPageType} */
const decoderType = /** @type {typeof Unified.DECODER_TYPES[number]} */ (value);
/** @type {TileSizePayload | null} */
const tileSize = session.lastTileSize;

module.exports = {
  prodEngine, fakeEngine, prodHost, fakeHost, controller, engines, hosts, onTransport, pageTransport, hostReads,
  hostPosts, descriptor, pageReads, controllerReads, hostCommand, decoderType, tileSize,
};
