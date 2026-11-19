// Vendor API mock only; never loads or solves a real CAPTCHA.
export function mockSmartCaptcha(window) {
  const widgets = new Map();
  const calls = { reset: [], destroy: [] };
  let nextId = 0;
  window.smartCaptcha = {
    render(container, options) { const id = nextId++; widgets.set(id, { options, events: new Map() }); return id; },
    subscribe(id, event, handler) { widgets.get(id).events.set(event, handler); return () => widgets.get(id)?.events.delete(event); },
    reset(id) { calls.reset.push(id); },
    destroy(id) { calls.destroy.push(id); widgets.delete(id); },
  };
  const last = () => [...widgets.values()].at(-1);
  return { calls, widgets, solve: (token = 'mock-one-use-token') => last().options.callback(token), emit: event => last().events.get(event)(), last };
}
