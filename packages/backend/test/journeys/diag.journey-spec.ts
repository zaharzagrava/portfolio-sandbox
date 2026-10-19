import { ControlSurface, adminClient } from './support/control-surface';
import { eventTap } from './support/event-tap';

describe('diag', () => {
  it('prints state', async () => {
    const admin = await adminClient();
    const control = new ControlSurface(admin);
    const out: Record<string, unknown> = {};
    out.soldOut = await eventTap('orders.events', { type: 'flashsale.sold_out', limit: 5 }).catch((e) => String(e.message).slice(0, 300));
    out.loaded = await eventTap('orders.events', { type: 'flashsale.loaded', limit: 3 }).catch((e) => String(e.message).slice(0, 300));
    out.router = await control.consumer('notification-router');
    console.log(JSON.stringify(out, null, 1));
  });
});
