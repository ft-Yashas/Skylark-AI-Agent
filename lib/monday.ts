const MONDAY_API_URL = "https://api.monday.com/v2";
const API_VERSION = "2024-10";

export type MondayColumn = {
  id: string;
  title: string;
  type: string;
};

export type MondayItem = {
  id: string;
  name: string;
  fields: Record<string, string>;
};

type SchemaCache = {
  [boardId: string]: { columns: MondayColumn[]; fetchedAt: number };
};

const schemaCache: SchemaCache = {};
const SCHEMA_TTL_MS = 5 * 60 * 1000;

function getToken(): string {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error(
      "MONDAY_API_TOKEN is not set. Add it to your environment variables."
    );
  }
  return token;
}

async function mondayGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getToken(),
      "API-Version": API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `monday.com API request failed (${res.status}): ${body.slice(0, 500)}`
    );
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(
      `monday.com API returned errors: ${JSON.stringify(json.errors).slice(
        0,
        800
      )}`
    );
  }
  return json.data as T;
}

export async function getBoardSchema(boardId: string): Promise<MondayColumn[]> {
  const cached = schemaCache[boardId];
  if (cached && Date.now() - cached.fetchedAt < SCHEMA_TTL_MS) {
    return cached.columns;
  }

  const query = `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        columns {
          id
          title
          type
        }
      }
    }
  `;
  const data = await mondayGraphQL<{
    boards: { columns: MondayColumn[] }[];
  }>(query, { boardId: [boardId] });

  const boards = data.boards;
  if (!boards || boards.length === 0) {
    throw new Error(
      `Board ${boardId} not found or not accessible with this API token.`
    );
  }

  const columns = boards[0].columns;
  schemaCache[boardId] = { columns, fetchedAt: Date.now() };
  return columns;
}

export async function getBoardItems(boardId: string): Promise<MondayItem[]> {
  const columns = await getBoardSchema(boardId);
  const idToTitle = new Map(columns.map((c) => [c.id, c.title]));

  const items: MondayItem[] = [];
  let cursor: string | null = null;
  let first = true;

  while (first || cursor) {
    first = false;

    type Page = {
      cursor: string | null;
      items: {
        id: string;
        name: string;
        column_values: { id: string; text: string | null }[];
      }[];
    };

    let page: Page;
    if (!cursor) {
      const query = `
        query ($boardId: [ID!], $limit: Int!) {
          boards(ids: $boardId) {
            items_page(limit: $limit) {
              cursor
              items {
                id
                name
                column_values {
                  id
                  text
                }
              }
            }
          }
        }
      `;
      const data = await mondayGraphQL<{
        boards: { items_page: Page }[];
      }>(query, { boardId: [boardId], limit: 100 });
      page = data.boards[0].items_page;
    } else {
      const query = `
        query ($cursor: String!, $limit: Int!) {
          next_items_page(cursor: $cursor, limit: $limit) {
            cursor
            items {
              id
              name
              column_values {
                id
                text
              }
            }
          }
        }
      `;
      const data = await mondayGraphQL<{ next_items_page: Page }>(query, {
        cursor,
        limit: 100,
      });
      page = data.next_items_page;
    }

    for (const item of page.items) {
      const fields: Record<string, string> = { "Item Name": item.name };
      for (const cv of item.column_values) {
        const title = idToTitle.get(cv.id) ?? cv.id;
        fields[title] = cv.text ?? "";
      }
      items.push({ id: item.id, name: item.name, fields });
    }

    cursor = page.cursor;

    if (items.length > 20000) break;
  }

  return items;
}
