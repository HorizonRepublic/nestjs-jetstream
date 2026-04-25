// IMPORTANT: register OTel SDK BEFORE any application module loads.
import './tracing';

import { bootstrap } from '../shared/bootstrap';

import { AppModule } from './app.module';

bootstrap(AppModule, 3009).catch((err) => {
  console.error('Failed to bootstrap tracing example:', err);
  process.exit(1);
});
