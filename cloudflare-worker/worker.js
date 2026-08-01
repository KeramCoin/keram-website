const MODEL = "@cf/meta/m2m100-1.2b";
const QUALITY_MODEL =
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const LANGUAGES = new Set(["hr", "en", "ru", "it"]);
const ORIGINS = new Set([
  "https://k3ram.com",
  "https://www.k3ram.com",
  "https://localhost",
  "http://localhost:3000",
  "http://localhost:8000",
  "http://localhost:8080"
]);

function cors(request) {
  const origin = request.headers.get("Origin");

  return {
    "Access-Control-Allow-Origin": ORIGINS.has(origin)
      ? origin
      : "https://k3ram.com",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors(request)
    }
  });
}

async function hashAuthorKey(authorKey) {
  const data = new TextEncoder().encode(authorKey);
  const hash = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function translate(env, text, source, target) {
  if (source === target) return text;

  const result = await env.AI.run(MODEL, {
    text,
    source_lang: source,
    target_lang: target
  });

  if (!result.translated_text) {
    throw new Error("Translation model returned no text.");
  }

  return result.translated_text;
}

async function translateQuality(env, text, source, target) {
  if (source === target) return text;

  const languageNames = {
    hr: "Croatian",
    en: "English",
    ru: "Russian",
    it: "Italian"
  };



  const result = await env.AI.run(QUALITY_MODEL, {
    messages: [
      {
        role: "system",
        content:
          `Translate from ${languageNames[source]} to ${languageNames[target]}. ` +
          "Return only the translated text. " +
          "KERAM and KGCL are brand names. Never translate, inflect, transliterate, or alter them. " +
          "Preserve every emoji exactly and in the same order. " +
          "Preserve names, punctuation, meaning and tone. " +
          "Do not explain. Do not mix languages."
      },
      {
        role: "user",
        content: text
      }
    ],
    temperature: 0
  });

  const translatedText = String(
    result.response || ""
  ).trim();

  if (!translatedText) {
    throw new Error(
      "Quality translation model returned no text."
    );
  }

  return translatedText;
}

async function translateForChat(env, text, source, target) {
  try {
    const translatedText = await translateQuality(
      env,
      text,
      source,
      target
    );

    const compactText = translatedText.replace(/\s/g, "");
    const hasLettersOrNumbers =
      /[\p{L}\p{N}]/u.test(translatedText);
    const isRepetitive =
      compactText.length > 20 &&
      new Set(compactText).size <= 3;
    const isTooLong =
      translatedText.length > Math.max(text.length * 8, 300);

    if (
      !hasLettersOrNumbers ||
      isRepetitive ||
      isTooLong
    ) {
      throw new Error(
        "Quality translation returned invalid text."
      );
    }

    return translatedText;
  } catch (error) {
    console.error(
      "Quality translation failed. Using legacy fallback.",
      error
    );

    return await translate(env, text, source, target);
  }
}

async function setupDatabase(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      language TEXT NOT NULL,
      translation_hr TEXT,
      translation_ru TEXT,
      translation_it TEXT,
      translation_en TEXT,
      created_at TEXT NOT NULL,
      author_key_hash TEXT,
      edited_at TEXT

    )
  `).run();

  const columns = await env.DB.prepare(`
    PRAGMA table_info(messages)
  `).all();

  const columnNames = new Set(
    columns.results.map((column) => column.name)
  );

  if (!columnNames.has("author_key_hash")) {
    await env.DB.prepare(`
      ALTER TABLE messages
      ADD COLUMN author_key_hash TEXT
    `).run();
  }

    if (!columnNames.has("edited_at")) {
    await env.DB.prepare(`
      ALTER TABLE messages
      ADD COLUMN edited_at TEXT
    `).run();
  }

  if (!columnNames.has("translation_ru")) {
    await env.DB.prepare(`
      ALTER TABLE messages
      ADD COLUMN translation_ru TEXT
    `).run();
  }

  if (!columnNames.has("translation_it")) {
    await env.DB.prepare(`
      ALTER TABLE messages
      ADD COLUMN translation_it TEXT
    `).run();
  }
}

function toMessage(row) {
  return {
    id: row.id,
    username: row.username,
    text: row.text,
    language: row.language,
    createdAt: row.created_at,
    authorKeyHash: row.author_key_hash,
    editedAt: row.edited_at,
    translations: {
      hr: row.translation_hr,
      en: row.translation_en,
      ru: row.translation_ru,
      it: row.translation_it
    }
  };
}

async function handleTranslation(request, env) {
  const data = await request.json();
  const text = String(data.text || "").trim();
  const source = String(
    data.sourceLanguage || ""
  ).toLowerCase();
  const target = String(
    data.targetLanguage || ""
  ).toLowerCase();

  if (!text || text.length > 1000) {
    return json(request, {
      error: "Text must contain 1 to 1000 characters."
    }, 400);
  }

  if (!LANGUAGES.has(source) || !LANGUAGES.has(target)) {
    return json(request, {
      error: "Supported languages are hr, en, ru and it."
    }, 400);
  }

  const translatedText = await translate(
    env,
    text,
    source,
    target
  );

  return json(request, {
    source,
    target,
    originalText: text,
    translatedText
  });
}

async function handleQualityTranslation(request, env) {
  const data = await request.json();
  const text = String(data.text || "").trim();
  const source = String(
    data.sourceLanguage || ""
  ).toLowerCase();
  const target = String(
    data.targetLanguage || ""
  ).toLowerCase();

  if (!text || text.length > 1000) {
    return json(request, {
      error: "Text must contain 1 to 1000 characters."
    }, 400);
  }

  if (!LANGUAGES.has(source) || !LANGUAGES.has(target)) {
    return json(request, {
      error: "Supported languages are hr, en, ru and it."
    }, 400);
  }

  const translatedText = await translateQuality(
    env,
    text,
    source,
    target
  );

  return json(request, {
    source,
    target,
    originalText: text,
    translatedText
  });
}

async function getMessages(request, env, url) {
  const language = String(
    url.searchParams.get("language") || "hr"
  ).toLowerCase();

  if (!LANGUAGES.has(language)) {
    return json(request, {
      error: "Supported languages are hr and en."
    }, 400);
  }

  const result = await env.DB.prepare(`
    SELECT * FROM (
      SELECT
        id,
        username,
        text,
        language,
        translation_hr,
        translation_en,
        translation_ru,
        translation_it,
        created_at,
        author_key_hash,
        edited_at

      FROM messages
      ORDER BY id DESC
      LIMIT 100
    )
    ORDER BY id ASC
  `).run();

  return json(request, {
    messages: result.results.map(toMessage)
  });
}

async function createMessage(request, env) {
  const data = await request.json();
  const username = String(data.username || "Builder").trim();
  const text = String(data.text || "").trim();
  const language = String(data.language || "").toLowerCase();
  const authorKey = String(data.authorKey || "").trim();

if (!authorKey || authorKey.length < 32 || authorKey.length > 100) {
  return json(request, {
    error: "Valid author key is required."
  }, 400);
}

  if (!username || username.length > 40) {
    return json(request, {
      error: "Username must contain 1 to 40 characters."
    }, 400);
  }

  if (!text || text.length > 500) {
    return json(request, {
      error: "Message must contain 1 to 500 characters."
    }, 400);
  }

  if (!LANGUAGES.has(language)) {
    return json(request, {
      error: "Supported languages are hr and en."
    }, 400);
  }
    const duplicateSince =
    new Date(Date.now() - 10000).toISOString();

  const duplicateMessage = await env.DB.prepare(`
    SELECT id
    FROM messages
    WHERE username = ?
      AND text = ?
      AND language = ?
      AND created_at >= ?
    ORDER BY id DESC
    LIMIT 1
  `).bind(
    username,
    text,
    language,
    duplicateSince
  ).first();

  if (duplicateMessage) {
    return json(request, {
      error: "Duplicate message blocked."
    }, 409);
  }

  const authorKeyHash = await hashAuthorKey(authorKey);
  const translations = {
  hr: language === "hr"
    ? text
    : await translateForChat(env, text, language, "hr"),

  en: language === "en"
    ? text
    : await translateForChat(env, text, language, "en"),

  ru: language === "ru"
    ? text
    : await translateForChat(env, text, language, "ru"),

  it: language === "it"
    ? text
    : await translateForChat(env, text, language, "it")
};

  const createdAt = new Date().toISOString();

  const result = await env.DB.prepare(`
    INSERT INTO messages (
      username,
      text,
      language,
      translation_hr,
      translation_en,
      translation_ru,
      translation_it,
      created_at,
      author_key_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    username,
    text,
    language,
    translations.hr,
    translations.en,
    translations.ru,
    translations.it,
    createdAt,
    authorKeyHash
  ).run();

  return json(request, {
    message: {
      id: result.meta.last_row_id,
      username,
      text,
      language,
      createdAt,
      authorKeyHash,
      translations
    }
  }, 201);
}

async function updateMessage(request, env, messageId) {
  const data = await request.json();
  const authorKey = String(data.authorKey || "").trim();
  const text = String(data.text || "").trim();

  if (!authorKey || authorKey.length < 32 || authorKey.length > 100) {
    return json(request, {
      error: "Valid author key is required."
    }, 400);
  }

  if (!text || text.length > 500) {
    return json(request, {
      error: "Message must contain 1 to 500 characters."
    }, 400);
  }

  const existingMessage = await env.DB.prepare(`
    SELECT *
    FROM messages
    WHERE id = ?
  `).bind(messageId).first();

  if (!existingMessage) {
    return json(request, {
      error: "Message not found."
    }, 404);
  }

  const authorKeyHash = await hashAuthorKey(authorKey);

  if (
    !existingMessage.author_key_hash ||
    existingMessage.author_key_hash !== authorKeyHash
  ) {
    return json(request, {
      error: "You cannot edit this message."
    }, 403);
  }

  const language = existingMessage.language;
const translations = {
  hr: language === "hr"
    ? text
    : await translateForChat(env, text, language, "hr"),

  en: language === "en"
    ? text
    : await translateForChat(env, text, language, "en"),

  ru: language === "ru"
    ? text
    : await translateForChat(env, text, language, "ru"),

  it: language === "it"
    ? text
    : await translateForChat(env, text, language, "it")
};

  const editedAt = new Date().toISOString();

  await env.DB.prepare(`
    UPDATE messages
    SET
      text = ?,
      translation_hr = ?,
      translation_en = ?,
      translation_ru = ?,
      translation_it = ?,
      edited_at = ?
    WHERE id = ?
  `).bind(
    text,
    translations.hr,
    translations.en,
    translations.ru,
    translations.it,
    editedAt,
    messageId
  ).run();

  const updatedMessage = await env.DB.prepare(`
    SELECT *
    FROM messages
    WHERE id = ?
  `).bind(messageId).first();

  return json(request, {
    message: toMessage(updatedMessage)
  });
}

async function getLatestMessage(request, env) {
  const latestMessage = await env.DB.prepare(`
    SELECT id
    FROM messages
    ORDER BY id DESC
    LIMIT 1
  `).first();

  return json(request, {
    latestMessageId:
      latestMessage?.id || 0
  });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors(request)
      });
    }

    try {
                if (
            request.method === "GET" &&
            (url.pathname === "/" || url.pathname === "/health")
          ) {
            return json(request, {
              name: "KGCL Public API",
              version: "0.3",
              status: "running",
              translationModel: QUALITY_MODEL,
              legacyTranslationModel: MODEL,
              database: "D1"
            });
          }
      if (
        request.method === "GET" &&
        url.pathname === "/api/messages/latest"
      ) {
        return await getLatestMessage(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/setup"
      ) {
        await setupDatabase(env);

        return json(request, {
          status: "ready",
          table: "messages"
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/translate"
      ) {
        return await handleTranslation(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/translate-quality"
      ) {
      return await handleQualityTranslation(request, env);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/messages"
      ) {
        return await getMessages(request, env, url);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/messages"
      ) {
        return await createMessage(request, env);
      }

      const messageRoute =
        url.pathname.match(/^\/api\/messages\/(\d+)$/);

      if (
        request.method === "PATCH" &&
        messageRoute
      ) {
        return await updateMessage(
          request,
          env,
          Number(messageRoute[1])
        );
      }

      return json(request, {
        error: "Route not found."
      }, 404);

    } catch (error) {
      return json(request, {
        error: error.message || "KGCL request failed."
      }, 500);
    }
  }
};