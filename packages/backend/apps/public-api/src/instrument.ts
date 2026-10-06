/** SD-33: first import of main.ts - starts OpenTelemetry before anything it instruments is loaded. */
import { startTelemetry } from '@app/common/telemetry/telemetry';

startTelemetry('public-api');
