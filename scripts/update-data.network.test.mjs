// Tests de contrat de la couche réseau de update-data.mjs (node --test).
//
// Ces fonctions font des `fetch`, mais AUCUN appel réseau réel n'est fait
// ici : on remplace `globalThis.fetch` par un bouchon le temps du test (les
// fonctions référencent le `fetch` global, pas un import, donc la
// substitution est transparente). On couvre ce que les fonctions pures ne
// voient pas : la terminaison de la pagination et son garde-fou anti-boucle,
// l'enchaînement des variantes RSI, la validation UEX, et la résilience
// (repli sur null / erreur) — la classe de bugs qui avait atteint la prod.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchText,
  fetchUexJson,
  fetchStorefrontListing,
  fetchStorefrontStandaloneShips,
  fetchShipMatrix,
  fetchRsiStandalone,
} from "./update-data.mjs";

// Remplace globalThis.fetch par `impl` le temps de `fn`, puis restaure —
// même en cas d'échec d'assertion (finally). Les tests d'un même fichier
// s'exécutent en série, donc la substitution globale est sûre.
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// Réponse minimale façon Response : juste ce que fetchText/rsiPost lisent.
function resp(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

// Enveloppe GraphQL du storefront pour une page donnée.
function storefrontEnvelope(resources, totalCount) {
  return resp([{ data: { store: { listing: { resources, totalCount } } } }]);
}

const requestedPage = (opts) => JSON.parse(opts.body)[0].variables.query.page;

// ---------------------------------------------------------------------------
// fetchText
// ---------------------------------------------------------------------------

test("fetchText renvoie le corps sur une réponse 2xx", async () => {
  await withFetch(
    async () => resp("coucou"),
    async () => {
      assert.equal(await fetchText("http://x"), "coucou");
    },
  );
});

test("fetchText lève sur un statut non-2xx", async () => {
  await withFetch(
    async () => resp("", { ok: false, status: 503 }),
    async () => {
      await assert.rejects(fetchText("http://x"), /HTTP 503/);
    },
  );
});

test("fetchText abandonne la requête après le délai (AbortController)", async () => {
  // fetch qui ne se résout jamais tant que le signal n'a pas été abandonné.
  const hang = (url, opts) =>
    new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  await withFetch(hang, async () => {
    await assert.rejects(fetchText("http://x", {}, 5), /aborted/);
  });
});

// ---------------------------------------------------------------------------
// fetchUexJson — validation de l'enveloppe UEX
// ---------------------------------------------------------------------------

test("fetchUexJson renvoie data quand status vaut ok", async () => {
  await withFetch(
    async () => resp({ status: "ok", data: [1, 2, 3] }),
    async () => {
      assert.deepEqual(await fetchUexJson("vehicles"), [1, 2, 3]);
    },
  );
});

test("fetchUexJson lève quand status n'est pas ok", async () => {
  await withFetch(
    async () => resp({ status: "error", data: [] }),
    async () => {
      await assert.rejects(fetchUexJson("vehicles"), /UEX/);
    },
  );
});

test("fetchUexJson lève quand data n'est pas un tableau", async () => {
  await withFetch(
    async () => resp({ status: "ok", data: {} }),
    async () => {
      await assert.rejects(fetchUexJson("vehicles"), /UEX/);
    },
  );
});

// ---------------------------------------------------------------------------
// fetchStorefrontListing — pagination
// ---------------------------------------------------------------------------

test("fetchStorefrontListing agrège plusieurs pages puis s'arrête à totalCount", async () => {
  let calls = 0;
  const stub = async (url, opts) => {
    calls += 1;
    return requestedPage(opts) === 1
      ? storefrontEnvelope([{ name: "A" }, { name: "B" }], 3)
      : storefrontEnvelope([{ name: "C" }], 3);
  };
  await withFetch(stub, async () => {
    const r = await fetchStorefrontListing("Op", "hash", "facet", 1, "ref", 2);
    assert.deepEqual(
      r.map((x) => x.name),
      ["A", "B", "C"],
    );
    assert.equal(calls, 2); // s'arrête dès que resources.length >= total
  });
});

test("fetchStorefrontListing s'arrête sur une page vide", async () => {
  await withFetch(
    async () => storefrontEnvelope([], 10),
    async () => {
      assert.deepEqual(await fetchStorefrontListing("Op", "hash", "facet", 1, "ref"), []);
    },
  );
});

test("fetchStorefrontListing respecte le garde-fou anti-boucle (page > 20)", async () => {
  // totalCount ment (1000) et chaque page ne rend qu'un élément : sans le
  // garde-fou, la boucle serait infinie.
  let calls = 0;
  const stub = async (url, opts) => {
    calls += 1;
    return storefrontEnvelope([{ name: `p${requestedPage(opts)}` }], 1000);
  };
  await withFetch(stub, async () => {
    const r = await fetchStorefrontListing("Op", "hash", "facet", 1, "ref");
    assert.equal(r.length, 20);
    assert.equal(calls, 20);
  });
});

// ---------------------------------------------------------------------------
// fetchStorefrontStandaloneShips — mapping + résilience
// ---------------------------------------------------------------------------

test("fetchStorefrontStandaloneShips mappe prix (centimes /100) et disponibilité", async () => {
  await withFetch(
    async () =>
      storefrontEnvelope(
        [{ name: "Anvil Carrack", nativePrice: { amount: 60000 }, stock: { available: true } }],
        1,
      ),
    async () => {
      const r = await fetchStorefrontStandaloneShips();
      assert.deepEqual(r["anvil carrack"], { available: true, price: 600 });
    },
  );
});

test("fetchStorefrontStandaloneShips renvoie null si le catalogue est injoignable", async () => {
  await withFetch(
    async () => {
      throw new Error("down");
    },
    async () => {
      assert.equal(await fetchStorefrontStandaloneShips(), null);
    },
  );
});

// ---------------------------------------------------------------------------
// fetchShipMatrix
// ---------------------------------------------------------------------------

test("fetchShipMatrix mappe le statut Concept", async () => {
  const body = {
    data: [
      { name: "Carrack", production_status: "flight-ready" },
      { name: "Zeus", production_status: "in-concept" },
    ],
  };
  await withFetch(
    async () => resp(body),
    async () => {
      const r = await fetchShipMatrix();
      assert.equal(r.carrack, false);
      assert.equal(r.zeus, true);
    },
  );
});

test("fetchShipMatrix renvoie null si la source est injoignable", async () => {
  await withFetch(
    async () => {
      throw new Error("boom");
    },
    async () => {
      assert.equal(await fetchShipMatrix(), null);
    },
  );
});

// ---------------------------------------------------------------------------
// fetchRsiStandalone — enchaînement des variantes
// ---------------------------------------------------------------------------

test("fetchRsiStandalone essaie les variantes et renvoie le premier résultat exploitable", async () => {
  // Sonde OK ; 1re variante (filterShips) renvoie des erreurs GraphQL ;
  // 2e variante renvoie enfin une liste de vaisseaux exploitable.
  const stub = async (url, opts) => {
    const q = JSON.parse(opts.body).query;
    if (q.includes("__typename")) return resp({ data: { __typename: "Query" } });
    if (q.includes("filterShips")) return resp({ errors: [{ message: "schema a changé" }] });
    return resp({ data: { to: { ships: [{ name: "Carrack", skus: [{ available: true }] }] } } });
  };
  await withFetch(stub, async () => {
    const r = await fetchRsiStandalone();
    assert.equal(r.carrack, true);
  });
});

test("fetchRsiStandalone renvoie null quand la sonde initiale échoue", async () => {
  await withFetch(
    async () => resp("nope", { ok: false, status: 500 }),
    async () => {
      assert.equal(await fetchRsiStandalone(), null);
    },
  );
});
