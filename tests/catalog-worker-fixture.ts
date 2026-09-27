import { readFile } from "node:fs/promises";
if (process.env.NODE_ENV !== "test" || !process.env.CATALOG_FIXTURE_PATH)
  throw new Error("Isolated test fixture only");
globalThis.fetch = async (input: any) => {
  const url = String(input);
  if (
    url !==
    "https://boards-api.greenhouse.io/v1/boards/catalog-fixture/jobs?content=true"
  )
    throw new Error("TEST_NETWORK_DESTINATION_FORBIDDEN");
  return new Response(
    await readFile(process.env.CATALOG_FIXTURE_PATH!, "utf8"),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
