interface Resources {
  engine(): Promise<void> | void;
  host(): Promise<void> | void;
  commands(): Promise<void> | void;
  extensions(): Promise<void> | void;
}

/** Never release prepared context pins before their consumers and IPC settle. */
export async function quiesceExtensions(resources: Resources): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(resources.engine),
    Promise.resolve().then(resources.host),
    Promise.resolve().then(resources.commands),
  ]);
  const errors = results.flatMap((result, index) => result.status === 'rejected'
    ? [`${['engine', 'host', 'accepted commands'][index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
  if (errors.length) throw new Error(errors.join('; '));
  await resources.extensions();
}
