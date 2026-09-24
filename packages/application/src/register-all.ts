/**
 * Side-effect imports that register every module's jobs, outbox consumers and schedules.
 * The worker imports this file once. Modules add one line each.
 */
import './platform';
import './media';
import './work';
import './platform';
import './team';
import './ofm';
import './finance';
import './production';
import './publishing';
import './automation';
import './insights';
