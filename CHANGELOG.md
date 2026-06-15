# Changelog

## 2.5.0 (2026-06-15)


### ⚠ BREAKING CHANGES

* replace nanos() with toNanos(value, unit) ([#73](https://github.com/HorizonRepublic/nestjs-jetstream/issues/73))

### Features

* - Configure Jest for testing and coverage integration ([b7ff4d4](https://github.com/HorizonRepublic/nestjs-jetstream/commit/b7ff4d4922fc10d74d31242ad3dc6d7552df91db))
* **Update `README.md`, adjust consumer configuration, and refine dependencies** ([#2](https://github.com/HorizonRepublic/nestjs-jetstream/issues/2)) ([347a119](https://github.com/HorizonRepublic/nestjs-jetstream/commit/347a11909776011f549d5c43a7b5b48ae008d4af))
* add Docusaurus documentation site ([#68](https://github.com/HorizonRepublic/nestjs-jetstream/issues/68)) ([816f152](https://github.com/HorizonRepublic/nestjs-jetstream/commit/816f1524f96e33d372e5b861ac9c4b431479e074))
* add ordered consumers for strict sequential event delivery ([#67](https://github.com/HorizonRepublic/nestjs-jetstream/issues/67)) ([9513b80](https://github.com/HorizonRepublic/nestjs-jetstream/commit/9513b805f71bfccaa806201398cf62c2acfc5217))
* add setMessageId for custom deduplication, remove unused reserved headers ([#64](https://github.com/HorizonRepublic/nestjs-jetstream/issues/64)) ([00bb2ce](https://github.com/HorizonRepublic/nestjs-jetstream/commit/00bb2ce42c5d3c6fcb6410ddb19e4e6510ba42a3))
* built-in OpenTelemetry distributed tracing (W3C Trace Context) ([#146](https://github.com/HorizonRepublic/nestjs-jetstream/issues/146)) ([71a9d9a](https://github.com/HorizonRepublic/nestjs-jetstream/commit/71a9d9a1ecf756376722f9d322a8673f1da2277b))
* client error unification, disconnect fail-fast, dead letter queue (v2.2.0) ([#34](https://github.com/HorizonRepublic/nestjs-jetstream/issues/34)) ([8d45ef0](https://github.com/HorizonRepublic/nestjs-jetstream/commit/8d45ef029744e14ce5d2e5d8d8826160f1ff54f8))
* **docs:** redesign documentation site ([#149](https://github.com/HorizonRepublic/nestjs-jetstream/issues/149)) ([ee4c99d](https://github.com/HorizonRepublic/nestjs-jetstream/commit/ee4c99df13d6b08d08041eb5e78afcd0109deecd))
* dual CJS/ESM build, supply chain hardening, cleanup ([fd896e6](https://github.com/HorizonRepublic/nestjs-jetstream/commit/fd896e6708253d1335b1727460a1e11a4524ab94))
* dual CJS/ESM build, Vitest migration (v2.3.0) ([#35](https://github.com/HorizonRepublic/nestjs-jetstream/issues/35)) ([ffc2fbd](https://github.com/HorizonRepublic/nestjs-jetstream/commit/ffc2fbdfa3d9a763f5181534204154439a777aec))
* first-class Dead Letter Queue (DLQ) ([#123](https://github.com/HorizonRepublic/nestjs-jetstream/issues/123)) ([d013c50](https://github.com/HorizonRepublic/nestjs-jetstream/commit/d013c50eff4f27145bbb5dbd04d91bd2715b4419))
* handler metadata registry (NATS KV) ([#110](https://github.com/HorizonRepublic/nestjs-jetstream/issues/110)) ([#121](https://github.com/HorizonRepublic/nestjs-jetstream/issues/121)) ([2549aee](https://github.com/HorizonRepublic/nestjs-jetstream/commit/2549aee0715d65204ae9b4f736fc7084775ffddb))
* handler-controlled settlement, metadata getters, and hot-path performance ([#92](https://github.com/HorizonRepublic/nestjs-jetstream/issues/92)) ([c6e5f82](https://github.com/HorizonRepublic/nestjs-jetstream/commit/c6e5f82dca15e12d5968d575370a0cf9128c1839))
* message scheduling (delayed jobs) ([#114](https://github.com/HorizonRepublic/nestjs-jetstream/issues/114)) ([40e85b7](https://github.com/HorizonRepublic/nestjs-jetstream/commit/40e85b7fbf3d87d26471f28e51b0e47d6a78ca60))
* migrate from nats to @nats-io/* scoped packages (v3.x) ([#112](https://github.com/HorizonRepublic/nestjs-jetstream/issues/112)) ([d4835a4](https://github.com/HorizonRepublic/nestjs-jetstream/commit/d4835a40641aae67d66faa0b30f5382d906f0a2a))
* **observability:** add HandlerCompleted transport event and HandlerStatus type ([1fc3246](https://github.com/HorizonRepublic/nestjs-jetstream/commit/1fc32466fcbe383d8c26c49ea22d69b249c7a029))
* **observability:** add JetstreamMetricsModule and metrics module option ([c0840ab](https://github.com/HorizonRepublic/nestjs-jetstream/commit/c0840ab6a7387c459190eae14e02427232c8fd1a))
* **observability:** add JetstreamMetricsService with EventBus subscriptions ([e235084](https://github.com/HorizonRepublic/nestjs-jetstream/commit/e235084b71e1f66332c11e7b9f4c6a925bedd64d))
* **observability:** add metrics constants and error-context prefix map ([890940d](https://github.com/HorizonRepublic/nestjs-jetstream/commit/890940d093817a7c4937a293f84825f6069cfd0c))
* **observability:** add polling loop for consumer + stream gauges ([124e88b](https://github.com/HorizonRepublic/nestjs-jetstream/commit/124e88b47570e09a539e36f00075df9e4cbba5c0))
* **observability:** declare prom-client as optional peer dependency ([82d41be](https://github.com/HorizonRepublic/nestjs-jetstream/commit/82d41be52dd18624ae300a246291215c35251edd))
* **observability:** emit HandlerCompleted from all routers and wire metrics handlers ([d513d41](https://github.com/HorizonRepublic/nestjs-jetstream/commit/d513d41b994a4f93e82e975beeec99747291a6a8))
* **observability:** emit Published and RpcCompleted from JetstreamClient ([77e6717](https://github.com/HorizonRepublic/nestjs-jetstream/commit/77e6717f25c609c1e1d3febca59a9750fc5567ce))
* **observability:** instantiate prom-client metrics on configurable register ([711663d](https://github.com/HorizonRepublic/nestjs-jetstream/commit/711663dd5eb45540897799282cde43c683e22ef8))
* **observability:** introduce metrics config types and prom-client dev dep ([8ee18f7](https://github.com/HorizonRepublic/nestjs-jetstream/commit/8ee18f76de63198ceebc98ce9607cabc79a5ddc4))
* **observability:** map free-form error contexts to bounded enum ([54bbf81](https://github.com/HorizonRepublic/nestjs-jetstream/commit/54bbf81aac0f0bea6466cee9f6e63a69ff813643))
* **observability:** Prometheus metrics ([#164](https://github.com/HorizonRepublic/nestjs-jetstream/issues/164)) ([41217e4](https://github.com/HorizonRepublic/nestjs-jetstream/commit/41217e410dda2de5dd15050aceea85d20803d0db))
* **observability:** support multiple subscribers per transport event ([95136a0](https://github.com/HorizonRepublic/nestjs-jetstream/commit/95136a0f27dc7cb1cd2e1a492915c06e05ddc49e))
* **observability:** wire metrics module into forRoot and forRootAsync ([70af78f](https://github.com/HorizonRepublic/nestjs-jetstream/commit/70af78f656e0b30bffd461f479cb5c45a0b86f0e))
* per-message TTL via JetstreamRecordBuilder.ttl() ([#120](https://github.com/HorizonRepublic/nestjs-jetstream/issues/120)) ([876b57f](https://github.com/HorizonRepublic/nestjs-jetstream/commit/876b57f379ffb523731e7ac3212e990ce953c409))
* performance optimization + code quality refactoring ([#83](https://github.com/HorizonRepublic/nestjs-jetstream/issues/83)) ([9bca8c1](https://github.com/HorizonRepublic/nestjs-jetstream/commit/9bca8c1294400c9f6b2cdf06887301d1783ab8d1))
* **provisioning:** bind to externally managed streams and consumers ([#187](https://github.com/HorizonRepublic/nestjs-jetstream/issues/187)) ([8c5a7fa](https://github.com/HorizonRepublic/nestjs-jetstream/commit/8c5a7fa60587a8362c2ff85a1f80cd47fe9197d8))
* **provisioning:** boot summary, actionable errors, and opt-in storage preflight ([#175](https://github.com/HorizonRepublic/nestjs-jetstream/issues/175)) ([08b6d9d](https://github.com/HorizonRepublic/nestjs-jetstream/commit/08b6d9d31845d5776e926c068a28cd7c7303bc8d))
* RpcException, health indicator, tests, docs (v2.1.0) ([0ed6a80](https://github.com/HorizonRepublic/nestjs-jetstream/commit/0ed6a8044c7e0f725b68660d3c7e613189a178a8))
* stream migration & self-healing consumer recovery ([#118](https://github.com/HorizonRepublic/nestjs-jetstream/issues/118)) ([b55b0f0](https://github.com/HorizonRepublic/nestjs-jetstream/commit/b55b0f04c9d4621c393ea37f710c13deb6d82aef))
* v2.0.0 — complete rewrite of nestjs-jetstream ([8d3c683](https://github.com/HorizonRepublic/nestjs-jetstream/commit/8d3c68329294352b17cf043fc72a8707d5685166))


### Bug Fixes

* Add Export Essential Naming and Subject Helpers ([#96](https://github.com/HorizonRepublic/nestjs-jetstream/issues/96)) ([ad026c8](https://github.com/HorizonRepublic/nestjs-jetstream/commit/ad026c8b4afd642a39701bb58f4d7398c6e81129))
* add scheduling guide to sidebar navigation ([ed65fc8](https://github.com/HorizonRepublic/nestjs-jetstream/commit/ed65fc8d08c03d79e40722657dc47b47bf2ba1d4))
* address CodeRabbit review feedback ([c31e0fb](https://github.com/HorizonRepublic/nestjs-jetstream/commit/c31e0fb1fb8b9e6cc51c6431dcf6c63bbb3d5e4f))
* catch async hook rejections in EventBus ([#56](https://github.com/HorizonRepublic/nestjs-jetstream/issues/56)) ([94d5573](https://github.com/HorizonRepublic/nestjs-jetstream/commit/94d5573ca7b516ebee2fbd662422b38103593bf5))
* **ci:** add npm publish to release-please workflow ([#47](https://github.com/HorizonRepublic/nestjs-jetstream/issues/47)) ([df26d21](https://github.com/HorizonRepublic/nestjs-jetstream/commit/df26d212247f685382792f779ed1661ff2bc9de6))
* **client:** log warning on duplicate JetStream publish ack ([9480194](https://github.com/HorizonRepublic/nestjs-jetstream/commit/9480194ff48d02a47132b20378b6f700a9e960fe))
* **client:** publish each scheduled message to a unique schedule subject ([#178](https://github.com/HorizonRepublic/nestjs-jetstream/issues/178)) ([7434452](https://github.com/HorizonRepublic/nestjs-jetstream/commit/7434452a102eadba1d8e54e432eb76e4f718fcf4))
* close silent data-loss and reliability gaps across the transport ([#180](https://github.com/HorizonRepublic/nestjs-jetstream/issues/180)) ([3461cda](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3461cda9f0995f9478d55159ba54b6cc39a7bfa7))
* **connection:** clear connectionPromise on establish failure ([429e6a1](https://github.com/HorizonRepublic/nestjs-jetstream/commit/429e6a14d1b13503d7676fb4ecfba20de261985e))
* correct DLQ threshold for unlimited retries, clear jsmPromise on rejection ([#60](https://github.com/HorizonRepublic/nestjs-jetstream/issues/60)) ([8fb0f6f](https://github.com/HorizonRepublic/nestjs-jetstream/commit/8fb0f6fe063bbc0a3f33266e14293bd1078d981c))
* correct Observable&lt;void&gt; type in ordered event handler ([3fcb2fe](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3fcb2fe82956870401a11a29f242555c7c26aca4))
* **dlq:** change Dead Letter Queue retention policy to Limits ([#177](https://github.com/HorizonRepublic/nestjs-jetstream/issues/177)) ([07e8b23](https://github.com/HorizonRepublic/nestjs-jetstream/commit/07e8b23f8c38e992fa4fcfdc58537f06f457c55b))
* **docs:** collapse README badge anchors and add brand logos ([31d25ff](https://github.com/HorizonRepublic/nestjs-jetstream/commit/31d25ff132881ee10e00392e8103b7218af59a95))
* **docs:** hardcode NestJS peer major on landing ([807b957](https://github.com/HorizonRepublic/nestjs-jetstream/commit/807b95796277be574381334aa72acd6a834d992a))
* guard against empty broadcast patterns, fix README inaccuracies ([#61](https://github.com/HorizonRepublic/nestjs-jetstream/issues/61)) ([7638c90](https://github.com/HorizonRepublic/nestjs-jetstream/commit/7638c9005d687d7f3abe68f92f1020054ec7b2a2))
* guard subscribeToFirst error handler against post-resolve rejection ([#76](https://github.com/HorizonRepublic/nestjs-jetstream/issues/76)) ([e0a48fb](https://github.com/HorizonRepublic/nestjs-jetstream/commit/e0a48fbe45976efc0a9526c3c8a61a0628f886b7))
* hardening & bugfixes — 10 issues + README restructure ([#43](https://github.com/HorizonRepublic/nestjs-jetstream/issues/43)) ([5cbcd46](https://github.com/HorizonRepublic/nestjs-jetstream/commit/5cbcd4601529d71ab303da9cf80d532f673fd366))
* lower Node.js engine requirement to &gt;= 20.0.0 ([#62](https://github.com/HorizonRepublic/nestjs-jetstream/issues/62)) ([93ebcf7](https://github.com/HorizonRepublic/nestjs-jetstream/commit/93ebcf7025adf39b947952851f8965da32b859db))
* **message-provider:** add exponential backoff for consumer restart ([7963f31](https://github.com/HorizonRepublic/nestjs-jetstream/commit/7963f31a5261f8f7b6ea0f97a6222f2d69e894b5))
* **message-provider:** stop NATS consumer iterator on destroy ([f1d9385](https://github.com/HorizonRepublic/nestjs-jetstream/commit/f1d9385686e9453d3b3994532aa9cc11e0c5cda2))
* **observability:** address CodeRabbit review feedback ([d500b9c](https://github.com/HorizonRepublic/nestjs-jetstream/commit/d500b9c6ddd02f7ca09368cfa038aee70e33e06c))
* **observability:** emit ConsumerRecovered after self-healing ([#154](https://github.com/HorizonRepublic/nestjs-jetstream/issues/154)) ([9ed5051](https://github.com/HorizonRepublic/nestjs-jetstream/commit/9ed505167670ca2a87a2bd8aadcbe646b0924c69))
* **observability:** keep prom-client truly optional via type-only imports ([e109aa0](https://github.com/HorizonRepublic/nestjs-jetstream/commit/e109aa0e3993975bfc1e985fea702e10ca516220))
* **observability:** unify metrics and otel under the factory result ([#171](https://github.com/HorizonRepublic/nestjs-jetstream/issues/171)) ([2a08706](https://github.com/HorizonRepublic/nestjs-jetstream/commit/2a0870690e1ef2b64c65f68e3acfd497c16a543c))
* post-v2.9.0 documentation sweep and public API cleanup ([#128](https://github.com/HorizonRepublic/nestjs-jetstream/issues/128)) ([5d64a35](https://github.com/HorizonRepublic/nestjs-jetstream/commit/5d64a35396d396169008df11856d6e824950e927))
* prevent shutdown race with in-flight connection, deduplicate JSM creation ([#55](https://github.com/HorizonRepublic/nestjs-jetstream/issues/55)) ([7314497](https://github.com/HorizonRepublic/nestjs-jetstream/commit/731449774bdaa2510d647b59dc0cc66979ef8a9d))
* reinitialize MessageProvider subjects after destroy, fix backoff logic ([#57](https://github.com/HorizonRepublic/nestjs-jetstream/issues/57)) ([e97d999](https://github.com/HorizonRepublic/nestjs-jetstream/commit/e97d9996412deec9cbda9dc98f186864d24d87db))
* remove default hook logging that spams application logs ([#45](https://github.com/HorizonRepublic/nestjs-jetstream/issues/45)) ([d3ea2f1](https://github.com/HorizonRepublic/nestjs-jetstream/commit/d3ea2f113a627c5942700d7d193948610d92ec8b))
* replace unsafe NatsError casts with instanceof checks ([43a06fc](https://github.com/HorizonRepublic/nestjs-jetstream/commit/43a06fcb5226c204a6ebfca2976943756af29f17))
* respond with error when no Core RPC handler found ([#51](https://github.com/HorizonRepublic/nestjs-jetstream/issues/51)) ([21bb0ec](https://github.com/HorizonRepublic/nestjs-jetstream/commit/21bb0eced37284330804457e90857202eb6ac662))
* revert typescript to 5.9 (TS 6 breaks DTS build via baseUrl deprecation) ([fc6b0ff](https://github.com/HorizonRepublic/nestjs-jetstream/commit/fc6b0ff38a6416ecd88da2124babd7e933e1f77d))
* **routing:** fail-fast on duplicate handler patterns ([#166](https://github.com/HorizonRepublic/nestjs-jetstream/issues/166)) ([0ddaa06](https://github.com/HorizonRepublic/nestjs-jetstream/commit/0ddaa06de91be63c9073543867e9cb6e09b92313))
* **rpc-router:** ack before publish to prevent message loss ([a4cb2ab](https://github.com/HorizonRepublic/nestjs-jetstream/commit/a4cb2aba7e89670f8d5b162918eb737e2d4ea19e))
* **shutdown:** clear safety timeout after successful drain ([38a998b](https://github.com/HorizonRepublic/nestjs-jetstream/commit/38a998bc0a276a07194e7c2824b093082e4cc04e))
* **strategy:** don't call callback on duplicate listen() to avoid false startup signal ([a04af7f](https://github.com/HorizonRepublic/nestjs-jetstream/commit/a04af7fedc1228e61db40481f2f3d9aec9037aa0))
* **strategy:** guard listen() against double invocation, remove dead listener code ([846b44e](https://github.com/HorizonRepublic/nestjs-jetstream/commit/846b44ebdfee65461a4ceb52339332c20b33997a))
* **strategy:** remove private logger that shadows Server base class ([ebc59cc](https://github.com/HorizonRepublic/nestjs-jetstream/commit/ebc59cc1cfb9496f679ccacebf75ede721689957))
* **strategy:** reset started flag in close() to allow restart ([e1de411](https://github.com/HorizonRepublic/nestjs-jetstream/commit/e1de411647c7c03a724c1b94005e78e2deaa6919))
* **strategy:** restore on() event listener storage for client use ([75eaf76](https://github.com/HorizonRepublic/nestjs-jetstream/commit/75eaf765436e89ba765fbef23c7c922563eff478))
* **streams:** drop the self-overlapping broadcast schedule subject ([#185](https://github.com/HorizonRepublic/nestjs-jetstream/issues/185)) ([b2fa4b1](https://github.com/HorizonRepublic/nestjs-jetstream/commit/b2fa4b1859df326b0eab149f98658489151a847b))
* throw on unwrap() when connection is not established ([68cd9ba](https://github.com/HorizonRepublic/nestjs-jetstream/commit/68cd9bacd9c87bb1a89a015dda5144bf6e34a10a))
* unsubscribe Observable in unwrapResult to prevent memory leak ([#58](https://github.com/HorizonRepublic/nestjs-jetstream/issues/58)) ([61b4aa6](https://github.com/HorizonRepublic/nestjs-jetstream/commit/61b4aa6ada62160ecb0d832487b240ec0ecc8c50))
* update existing consumers on startup, build DLQ threshold from NATS ([#53](https://github.com/HorizonRepublic/nestjs-jetstream/issues/53)) ([03812b4](https://github.com/HorizonRepublic/nestjs-jetstream/commit/03812b4c17ce04283320ad819b5f33d54fb484b4))
* use shared unwrapResult in EventRouter for consistent handler unwrapping ([#54](https://github.com/HorizonRepublic/nestjs-jetstream/issues/54)) ([a9a47ca](https://github.com/HorizonRepublic/nestjs-jetstream/commit/a9a47ca827246e459ab31c2ad6e4ceda230dfcae))


### Performance Improvements

* hot-path routing optimizations + MsgpackCodec ([#135](https://github.com/HorizonRepublic/nestjs-jetstream/issues/135)) ([79a1fa4](https://github.com/HorizonRepublic/nestjs-jetstream/commit/79a1fa475e5fefccd6c6219f88030757339a3c79))


### Miscellaneous Chores

* override release version ([ac05e5a](https://github.com/HorizonRepublic/nestjs-jetstream/commit/ac05e5ab2a425168fbbdceed6e242253b6d93563))


### Code Refactoring

* replace nanos() with toNanos(value, unit) ([#73](https://github.com/HorizonRepublic/nestjs-jetstream/issues/73)) ([fd43b83](https://github.com/HorizonRepublic/nestjs-jetstream/commit/fd43b83a662ecbf2ff3fdd1c14c4262c3a2a6441))

## [2.13.0](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.12.1...v2.13.0) (2026-06-15)


### Features

* **naming:** honor custom stream names, durable names, and subject prefixes ([2303add](https://github.com/HorizonRepublic/nestjs-jetstream/commit/2303add7a71210f238744426656c7d531173adb9))
* **provisioning:** bind to externally managed streams and consumers with ManagementMode.Manual ([2303add](https://github.com/HorizonRepublic/nestjs-jetstream/commit/2303add7a71210f238744426656c7d531173adb9))


### Bug Fixes

* **binder:** reject schedule-swallowing consumer filters at boot ([2303add](https://github.com/HorizonRepublic/nestjs-jetstream/commit/2303add7a71210f238744426656c7d531173adb9))
* **binder:** treat unfiltered consumers as covering handler subjects ([2303add](https://github.com/HorizonRepublic/nestjs-jetstream/commit/2303add7a71210f238744426656c7d531173adb9))
* **naming:** route self-rpc, broadcast publish, and metrics labels through the resolver ([2303add](https://github.com/HorizonRepublic/nestjs-jetstream/commit/2303add7a71210f238744426656c7d531173adb9))

## [2.12.1](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.12.0...v2.12.1) (2026-06-11)


### Bug Fixes

* **streams:** drop the self-overlapping broadcast schedule subject ([#185](https://github.com/HorizonRepublic/nestjs-jetstream/issues/185)) ([cde5fd9](https://github.com/HorizonRepublic/nestjs-jetstream/commit/cde5fd9176455f1a47ab7097e399a36800db5b5c))

## [2.12.0](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.11.1...v2.12.0) (2026-06-11)


### Features

* **provisioning:** boot summary, actionable errors, and opt-in storage preflight ([#175](https://github.com/HorizonRepublic/nestjs-jetstream/issues/175)) ([815fb6c](https://github.com/HorizonRepublic/nestjs-jetstream/commit/815fb6c0eaa31c5f467489172333248009e9e403))


### Bug Fixes

* **client:** apply ttl to the delivered message instead of the schedule holder ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **client:** fail fast when a JetStream RPC publish is deduplicated ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **client:** publish each scheduled message to a unique schedule subject ([#178](https://github.com/HorizonRepublic/nestjs-jetstream/issues/178)) ([573253b](https://github.com/HorizonRepublic/nestjs-jetstream/commit/573253b0f188a2b00c46e851b8dec9330a3f7236))
* **client:** reject scheduleAt for ordered patterns ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **codec:** decode empty payloads as undefined ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **dlq:** change Dead Letter Queue retention policy to Limits ([#177](https://github.com/HorizonRepublic/nestjs-jetstream/issues/177)) ([6f1b220](https://github.com/HorizonRepublic/nestjs-jetstream/commit/6f1b22057ce37d93bdccbdfeefb988366ed1928b))
* **dlq:** engage dead-letter handling when dlq is configured without onDeadLetter ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **dlq:** retry the DLQ publish in-process and stop promising redelivery ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **events:** capture unroutable messages in the DLQ instead of terminating them ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **events:** escalate ctx.retry() on the final delivery to dead-letter handling ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **headers:** block user-set NATS control headers and drop them from DLQ republish ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **migration:** close the data-loss windows in destructive stream migration ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **routing:** contain settlement failures on degraded connections ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **routing:** keep ack extension running for backlogged messages ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **server:** subscribe routers before consumers start delivering ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))
* **streams:** stop services from clobbering the shared broadcast stream ([3ece450](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3ece450a805f51f10bc14e12d51de6c2f96d7855))

## [2.11.1](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.11.0...v2.11.1) (2026-05-27)


### Bug Fixes

* **observability:** unify metrics and otel under the factory result ([#171](https://github.com/HorizonRepublic/nestjs-jetstream/issues/171)) ([70dce19](https://github.com/HorizonRepublic/nestjs-jetstream/commit/70dce19aa2a999b70a01b93530a9c410ae521784))

## [2.11.0](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.10.0...v2.11.0) (2026-05-27)


### Features

* **observability:** built-in Prometheus metrics ([#164](https://github.com/HorizonRepublic/nestjs-jetstream/issues/164)) ([ad32c35](https://github.com/HorizonRepublic/nestjs-jetstream/commit/ad32c353a9b01a6a225cb7d8acc580858234f50d)) — counters, histograms, and gauges covering throughput, handler / publish / RPC latency, consumer lag, dead letters, and connection health. Enabled via `forRoot({ metrics: true })`. Writes to a `prom-client` registry — pairs zero-config with `@willsoto/nestjs-prometheus` or any other `prom-client`-based exporter. `prom-client` is an optional peer; nothing is loaded when `metrics` is omitted.
* **observability:** new `TransportEvent` surface ([#164](https://github.com/HorizonRepublic/nestjs-jetstream/issues/164)) — `HandlerCompleted`, `Published`, and `RpcCompleted` join `ConsumerRecovered` as public hook signals, with `EventBus.subscribe()` supporting multiple subscribers per event so user hooks and built-in observers can coexist.
* **docs:** Diátaxis-aligned documentation refactor ([#165](https://github.com/HorizonRepublic/nestjs-jetstream/issues/165)) ([3e8e157](https://github.com/HorizonRepublic/nestjs-jetstream/commit/3e8e157193dd5ace5cf9c66a30bf3e7c2a07e96b)) — new top-level **Observability** section (overview + tracing + metrics), `Module Configuration` and `Release Notes` moved to `/reference`, how-to guides renamed to the `How to X` form, table-heavy pages restructured into prose / definition lists / TypeScript declarations.
* **docs:** custom domain at [nestjs-jetstream.horizon-republic.dev](https://nestjs-jetstream.horizon-republic.dev) — site now served from a dedicated subdomain on Cloudflare DNS. The old GitHub Pages URL 301-redirects automatically; bookmarks and external links keep working.
* **docs:** redesign documentation site ([#149](https://github.com/HorizonRepublic/nestjs-jetstream/issues/149)) ([c4a3c87](https://github.com/HorizonRepublic/nestjs-jetstream/commit/c4a3c87071c5b3e65dd2acf877529581ab287617))


### Bug Fixes

* **routing:** fail-fast on duplicate handler patterns ([#166](https://github.com/HorizonRepublic/nestjs-jetstream/issues/166)) ([fce2b69](https://github.com/HorizonRepublic/nestjs-jetstream/commit/fce2b69a6adbb1413e02a951dcc752cc37fa562b)) — `@EventPattern()` / `@MessagePattern()` declared twice with the same pattern string now throws at bootstrap. Previously NestJS silently overwrote duplicate RPC handlers (last wins) and appended duplicate event handlers to a linked list (double-ack / double-process every message) — both manifested only in production traffic.
* **observability:** emit `ConsumerRecovered` after self-healing succeeds, not on stream end ([#154](https://github.com/HorizonRepublic/nestjs-jetstream/issues/154)) ([2609f87](https://github.com/HorizonRepublic/nestjs-jetstream/commit/2609f87c9a78f7ce7c6c79eb6857cff3df5930d6))
* **docs:** README polish — collapsed badge anchors, hardcoded NestJS peer major on landing ([61668e1](https://github.com/HorizonRepublic/nestjs-jetstream/commit/61668e101ab56a473e781e17c4fb377556a9b315), [529ed08](https://github.com/HorizonRepublic/nestjs-jetstream/commit/529ed088286eb2af810195eba2bcde979e858ae6))

## [2.10.0](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.9.1...v2.10.0) (2026-04-25)


### Features

* built-in OpenTelemetry distributed tracing (W3C Trace Context) ([#146](https://github.com/HorizonRepublic/nestjs-jetstream/issues/146)) ([d8f77ef](https://github.com/HorizonRepublic/nestjs-jetstream/commit/d8f77efd60bdbcd41d891c87281407966608bc57))

## [2.9.1](https://github.com/HorizonRepublic/nestjs-jetstream/compare/v2.9.0...v2.9.1) (2026-04-16)


### Bug Fixes

* post-v2.9.0 documentation sweep and public API cleanup ([#128](https://github.com/HorizonRepublic/nestjs-jetstream/issues/128)) ([341c02c](https://github.com/HorizonRepublic/nestjs-jetstream/commit/341c02cada00ac251dc565f162de05e75b2bf5d1))


### Performance Improvements

* hot-path routing optimizations + MsgpackCodec ([#135](https://github.com/HorizonRepublic/nestjs-jetstream/issues/135)) ([01e6198](https://github.com/HorizonRepublic/nestjs-jetstream/commit/01e6198ed4f36b741d190b9454bc90b7cf5b3938))

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
