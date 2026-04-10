# Changelog

## [2.9.0](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.8.0...v2.9.0) (2026-04-10)


### Features

* first-class Dead Letter Queue (DLQ) ([#123](https://github.com/HorizonRepublic/nestjs-jetstream/issues/123)) ([835ec79](https://github.com/HorizonRepublic/nestjs-jetstream/commit/835ec79dbaaa81e4136da7d98117b06da68409a3))
* handler metadata registry (NATS KV) ([#110](https://github.com/HorizonRepublic/nestjs-jetstream/issues/110)) ([#121](https://github.com/HorizonRepublic/nestjs-jetstream/issues/121)) ([cd99694](https://github.com/HorizonRepublic/nestjs-jetstream/commit/cd996941615ad7db026120965ccaaa43507371df))
* per-message TTL via JetstreamRecordBuilder.ttl() ([#120](https://github.com/HorizonRepublic/nestjs-jetstream/issues/120)) ([d37fd62](https://github.com/HorizonRepublic/nestjs-jetstream/commit/d37fd62f691485eaa43fc6961167631db72dd8a8))
* stream migration & self-healing consumer recovery ([#118](https://github.com/HorizonRepublic/nestjs-jetstream/issues/118)) ([ddef850](https://github.com/HorizonRepublic/nestjs-jetstream/commit/ddef850124877ff2964b36bc083f7dcfdda853bf))

## [2.8.0](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.7.1...v2.8.0) (2026-04-01)


### Features

* message scheduling (delayed jobs) ([#114](https://github.com/HorizonRepublic/nestjs-jetstream/issues/114)) ([c7f2a0a](https://github.com/HorizonRepublic/nestjs-jetstream/commit/c7f2a0a1a2f648fdffbf62ec73b35f1b4e0fb29e))
* migrate from nats to @nats-io/* scoped packages (v3.x) ([#112](https://github.com/HorizonRepublic/nestjs-jetstream/issues/112)) ([9cf1054](https://github.com/HorizonRepublic/nestjs-jetstream/commit/9cf1054bcbd0afeec146f6e8dc54bf103063500e))


### Bug Fixes

* add scheduling guide to sidebar navigation ([723f94f](https://github.com/HorizonRepublic/nestjs-jetstream/commit/723f94f19a1e456139dbfcafc4cbac6a744089fd))

## [2.7.1](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.7.0...v2.7.1) (2026-03-30)


### Bug Fixes

* Add Export Essential Naming and Subject Helpers ([#96](https://github.com/HorizonRepublic/nestjs-jetstream/issues/96)) ([1cf5e2c](https://github.com/HorizonRepublic/nestjs-jetstream/commit/1cf5e2c7ebdb565d12777acd12c0eda857dea87f))

## [2.7.0](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.6.1...v2.7.0) (2026-03-30)


### Features

* handler-controlled settlement, metadata getters, and hot-path performance ([#92](https://github.com/HorizonRepublic/nestjs-jetstream/issues/92)) ([97d45e4](https://github.com/HorizonRepublic/nestjs-jetstream/commit/97d45e4be1ddf469ea40910251da7a3a38be983a))

## [2.6.1](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.6.0...v2.6.1) (2026-03-25)


### Bug Fixes

* revert typescript to 5.9 (TS 6 breaks DTS build via baseUrl deprecation) ([e3f2e36](https://github.com/HorizonRepublic/nestjs-jetstream/commit/e3f2e36eda38a29c1ce7740b252e9527da2f222d))

## [2.6.0](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.5.1...v2.6.0) (2026-03-25)


### Features

* performance optimization + code quality refactoring ([#83](https://github.com/HorizonRepublic/nestjs-jetstream/issues/83)) ([9c64d7d](https://github.com/HorizonRepublic/nestjs-jetstream/commit/9c64d7de3ed94237f3f4bdd091c562b75cfa0c8d))

## [2.5.1](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.5.0...v2.5.1) (2026-03-23)


### Bug Fixes

* guard subscribeToFirst error handler against post-resolve rejection ([#76](https://github.com/HorizonRepublic/nestjs-jetstream/issues/76)) ([7e69f30](https://github.com/HorizonRepublic/nestjs-jetstream/commit/7e69f30f7ac9232372990ec38d17f9fcedf8d902))

## [2.5.0](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.4.1...v2.5.0) (2026-03-21)


### ⚠ BREAKING CHANGES

* replace nanos() with toNanos(value, unit) ([#73](https://github.com/HorizonRepublic/nestjs-jetstream/issues/73))

### Miscellaneous Chores

* override release version ([f3e1152](https://github.com/HorizonRepublic/nestjs-jetstream/commit/f3e11528a5b127aa8d8ef17fd776cd72ba00b89e))


### Code Refactoring

* replace nanos() with toNanos(value, unit) ([#73](https://github.com/HorizonRepublic/nestjs-jetstream/issues/73)) ([49ccc93](https://github.com/HorizonRepublic/nestjs-jetstream/commit/49ccc93c0954598574e79711daffd85a17bebf42))

## [2.4.1](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.4.0...v2.4.1) (2026-03-20)


### Bug Fixes

* correct Observable&lt;void&gt; type in ordered event handler ([a489408](https://github.com/HorizonRepublic/nestjs-jetstream/commit/a48940807a663e568ce2440d1e59f1df3112f6a7))

## [2.4.0](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.3.6...v2.4.0) (2026-03-20)


### Features

* add Docusaurus documentation site ([#68](https://github.com/HorizonRepublic/nestjs-jetstream/issues/68)) ([c6a5a81](https://github.com/HorizonRepublic/nestjs-jetstream/commit/c6a5a814227b21ec8fce0873223fa1a17607fb7c))
* add ordered consumers for strict sequential event delivery ([#67](https://github.com/HorizonRepublic/nestjs-jetstream/issues/67)) ([d12e943](https://github.com/HorizonRepublic/nestjs-jetstream/commit/d12e9438d2e852ffe6c9cdba14c21f633cf7b0a5))
* add setMessageId for custom deduplication, remove unused reserved headers ([#64](https://github.com/HorizonRepublic/nestjs-jetstream/issues/64)) ([5e4c7a7](https://github.com/HorizonRepublic/nestjs-jetstream/commit/5e4c7a7816f72eb118a6379b4becce1d88a329b7))

## [2.3.6](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.3.5...v2.3.6) (2026-03-20)


### Bug Fixes

* lower Node.js engine requirement to &gt;= 20.0.0 ([#62](https://github.com/HorizonRepublic/nestjs-jetstream/issues/62)) ([1688430](https://github.com/HorizonRepublic/nestjs-jetstream/commit/1688430d56acf6772a031b1f464ac7e4435a0cac))

## [2.3.5](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.3.4...v2.3.5) (2026-03-20)


### Bug Fixes

* catch async hook rejections in EventBus ([#56](https://github.com/HorizonRepublic/nestjs-jetstream/issues/56)) ([d361bd5](https://github.com/HorizonRepublic/nestjs-jetstream/commit/d361bd5bd5b84b19dc975e01ed0f9e62450021ff))
* correct DLQ threshold for unlimited retries, clear jsmPromise on rejection ([#60](https://github.com/HorizonRepublic/nestjs-jetstream/issues/60)) ([d0917ad](https://github.com/HorizonRepublic/nestjs-jetstream/commit/d0917ad2881f9aa44db1ec6298be1f6b848ee3b1))
* guard against empty broadcast patterns, fix README inaccuracies ([#61](https://github.com/HorizonRepublic/nestjs-jetstream/issues/61)) ([51dcc35](https://github.com/HorizonRepublic/nestjs-jetstream/commit/51dcc35b525631ba113d19a9e3d36a96c085e366))
* prevent shutdown race with in-flight connection, deduplicate JSM creation ([#55](https://github.com/HorizonRepublic/nestjs-jetstream/issues/55)) ([83dd12a](https://github.com/HorizonRepublic/nestjs-jetstream/commit/83dd12a0acf9721756626f2c0f55c2d8de9d4c5c))
* reinitialize MessageProvider subjects after destroy, fix backoff logic ([#57](https://github.com/HorizonRepublic/nestjs-jetstream/issues/57)) ([3d8e696](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3d8e6969b022b7d82a3229a9b219fe56cd29e1c3))
* respond with error when no Core RPC handler found ([#51](https://github.com/HorizonRepublic/nestjs-jetstream/issues/51)) ([ae393a2](https://github.com/HorizonRepublic/nestjs-jetstream/commit/ae393a2b6051300a3a005dc40a72060d81c81eb8))
* unsubscribe Observable in unwrapResult to prevent memory leak ([#58](https://github.com/HorizonRepublic/nestjs-jetstream/issues/58)) ([b3367bf](https://github.com/HorizonRepublic/nestjs-jetstream/commit/b3367bf82ba101cc55a9fd85954a37f8b85eca7f))
* update existing consumers on startup, build DLQ threshold from NATS ([#53](https://github.com/HorizonRepublic/nestjs-jetstream/issues/53)) ([5310733](https://github.com/HorizonRepublic/nestjs-jetstream/commit/5310733233ce278ee038d234a685bb0e45fec220))
* use shared unwrapResult in EventRouter for consistent handler unwrapping ([#54](https://github.com/HorizonRepublic/nestjs-jetstream/issues/54)) ([de84398](https://github.com/HorizonRepublic/nestjs-jetstream/commit/de84398d7da748ca2c7acc5736a4644284d40603))

## [2.3.4](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.3.3...v2.3.4) (2026-03-20)


### Bug Fixes

* **ci:** add npm publish to release-please workflow ([#47](https://github.com/HorizonRepublic/nestjs-jetstream/issues/47)) ([d9c85ea](https://github.com/HorizonRepublic/nestjs-jetstream/commit/d9c85ea7b25c93ad4a616c83b2b74c5a0d2f7dce))

## [2.3.3](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.3.2...v2.3.3) (2026-03-20)


### Bug Fixes

* remove default hook logging that spams application logs ([#45](https://github.com/HorizonRepublic/nestjs-jetstream/issues/45)) ([77ec386](https://github.com/HorizonRepublic/nestjs-jetstream/commit/77ec38611981056ed03762d15ead0098a16eb902))
