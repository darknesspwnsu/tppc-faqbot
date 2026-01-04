// rpg/client_factory.js
// Shared factory for lazy RpgClient creation.

import { RpgClient } from "./rpg_client.js";

export function createRpgClientFactory() {
  let client = null;
  return () => {
    if (!client) client = new RpgClient();
    return client;
  };
}
