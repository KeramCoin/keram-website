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
    "Access-Control-Allow-Headers":
    "Content-Type, X-Room-Code, Authorization",
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

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(value) {
  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(
      value.slice(index * 2, index * 2 + 2),
      16
    );
  }

  return bytes;
}

function createSecureValue(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);

  crypto.getRandomValues(bytes);

  return bytesToHex(bytes);
}

async function hashPassword(password, salt) {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(salt),
      iterations: 100000
    },
    passwordKey,
    256
  );

  return bytesToHex(new Uint8Array(hash));
}

function valuesMatch(firstValue, secondValue) {
  if (firstValue.length !== secondValue.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < firstValue.length; index += 1) {
    difference |=
      firstValue.charCodeAt(index) ^
      secondValue.charCodeAt(index);
  }

  return difference === 0;
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

function extractEmojiSequence(value) {
  const emojiPattern =
    /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)/gu;

  return Array.from(
    String(value).matchAll(emojiPattern),
    match => match[0]
  );
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

const sourceEmojis = extractEmojiSequence(text);
const translatedEmojis =
  extractEmojiSequence(translatedText);
const hasEmojiMismatch =
  sourceEmojis.length !== translatedEmojis.length ||
  sourceEmojis.some(
    (emoji, index) => emoji !== translatedEmojis[index]
  );

if (
  !hasLettersOrNumbers ||
  isRepetitive ||
  isTooLong ||
  hasEmojiMismatch
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
      edited_at TEXT,
      room_id INTEGER
    )
  `).run();

    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      owner_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    )
  `).run();

    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      preferred_language TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS account_sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
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

    if (!columnNames.has("room_id")) {
    await env.DB.prepare(`
      ALTER TABLE messages
      ADD COLUMN room_id INTEGER
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
    roomId: row.room_id,
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

function normalizeRoomCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function generateRoomCode() {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const randomBytes = new Uint8Array(10);

  crypto.getRandomValues(randomBytes);

  const code = Array.from(
    randomBytes,
    (byte) => alphabet[byte % alphabet.length]
  ).join("");

  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

async function findRoomByCode(env, value) {
  const normalizedCode = normalizeRoomCode(value);

  if (normalizedCode.length !== 10) {
    return null;
  }

  const codeHash =
    await hashAuthorKey(normalizedCode);

  return await env.DB.prepare(`
    SELECT
      id,
      name,
      owner_key_hash,
      created_at
    FROM rooms
    WHERE code_hash = ?
      AND active = 1
    LIMIT 1
  `).bind(codeHash).first();
}

async function resolveRoomAccess(request, env) {
  const roomCode =
    request.headers.get("X-Room-Code");

  if (!roomCode) {
    return {
      room: null,
      error: null
    };
  }

  const room =
    await findRoomByCode(env, roomCode);

  if (!room) {
    return {
      room: null,
      error: json(request, {
        error: "Private room not found or code is invalid."
      }, 403)
    };
  }

  return {
    room,
    error: null
  };
}

async function createAccountSession(env, accountId) {
  const token = createSecureValue();
  const tokenHash = await hashAuthorKey(token);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  await env.DB.prepare(`
    INSERT INTO account_sessions (
      token_hash,
      account_id,
      created_at,
      expires_at
    )
    VALUES (?, ?, ?, ?)
  `).bind(
    tokenHash,
    accountId,
    createdAt,
    expiresAt
  ).run();

  return {
    token,
    expiresAt
  };
}

async function registerAccount(request, env) {
  const data = await request.json();

  const username = String(
    data.username || ""
  ).trim();

  const displayName = String(
    data.displayName || ""
  ).trim();

  const email = String(
    data.email || ""
  ).trim().toLowerCase();

  const password = String(
    data.password || ""
  );

  const preferredLanguage = String(
    data.preferredLanguage || ""
  ).trim().toLowerCase();

  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username)) {
    return json(request, {
      error:
        "Username must contain 3–30 letters, numbers, dots, hyphens or underscores."
    }, 400);
  }

  if (!displayName || displayName.length > 40) {
    return json(request, {
      error:
        "Display name must contain 1–40 characters."
    }, 400);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(request, {
      error: "Enter a valid email address."
    }, 400);
  }

  if (password.length < 8 || password.length > 128) {
    return json(request, {
      error:
        "Password must contain 8–128 characters."
    }, 400);
  }

  if (!LANGUAGES.has(preferredLanguage)) {
    return json(request, {
      error: "Choose a supported preferred language."
    }, 400);
  }

  const passwordSalt = createSecureValue(16);
  const passwordHash = await hashPassword(
    password,
    passwordSalt
  );
  const createdAt = new Date().toISOString();

  try {
    const result = await env.DB.prepare(`
      INSERT INTO accounts (
        username,
        display_name,
        email,
        password_hash,
        password_salt,
        preferred_language,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      username,
      displayName,
      email,
      passwordHash,
      passwordSalt,
      preferredLanguage,
      createdAt
    ).run();

    const accountId = Number(
      result.meta.last_row_id
    );

    const session = await createAccountSession(
      env,
      accountId
    );

    return json(request, {
      account: {
        id: accountId,
        username,
        displayName,
        email,
        preferredLanguage,
        createdAt
      },
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt
    }, 201);
  } catch (error) {
    if (
      String(error.message).includes(
        "UNIQUE constraint failed"
      )
    ) {
      return json(request, {
        error:
          "That username or email is already in use."
      }, 409);
    }

    throw error;
  }
}

function accountResponse(account) {
  return {
    id: Number(account.id),
    username: account.username,
    displayName: account.display_name,
    email: account.email,
    preferredLanguage: account.preferred_language,
    createdAt: account.created_at
  };
}

async function getAccountFromSession(request, env) {
  const authorization =
    request.headers.get("Authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization
    .slice("Bearer ".length)
    .trim();

  if (!token) {
    return null;
  }

  const tokenHash = await hashAuthorKey(token);

  return await env.DB.prepare(`
    SELECT
      accounts.id,
      accounts.username,
      accounts.display_name,
      accounts.email,
      accounts.preferred_language,
      accounts.created_at
    FROM account_sessions
    INNER JOIN accounts
      ON accounts.id = account_sessions.account_id
    WHERE account_sessions.token_hash = ?
      AND account_sessions.expires_at > ?
    LIMIT 1
  `).bind(
    tokenHash,
    new Date().toISOString()
  ).first();
}

async function loginAccount(request, env) {
  const data = await request.json();

  const email = String(
    data.email || ""
  ).trim().toLowerCase();

  const password = String(
    data.password || ""
  );

  if (!email || !password) {
    return json(request, {
      error: "Enter your email and password."
    }, 400);
  }

  const account = await env.DB.prepare(`
    SELECT *
    FROM accounts
    WHERE email = ?
    LIMIT 1
  `).bind(email).first();

  if (!account) {
    return json(request, {
      error: "Email or password is incorrect."
    }, 401);
  }

  const passwordHash = await hashPassword(
    password,
    account.password_salt
  );

  if (
    !valuesMatch(
      passwordHash,
      account.password_hash
    )
  ) {
    return json(request, {
      error: "Email or password is incorrect."
    }, 401);
  }

  const session = await createAccountSession(
    env,
    Number(account.id)
  );

  return json(request, {
    account: accountResponse(account),
    sessionToken: session.token,
    sessionExpiresAt: session.expiresAt
  });
}

async function getCurrentAccount(request, env) {
  const account = await getAccountFromSession(
    request,
    env
  );

  if (!account) {
    return json(request, {
      error: "Sign in is required."
    }, 401);
  }

  return json(request, {
    account: accountResponse(account)
  });
}



async function createRoom(request, env) {
  const data = await request.json();
  const name = String(data.name || "").trim();
  const authorKey =
    String(data.authorKey || "").trim();

  if (!name || name.length > 80) {
    return json(request, {
      error: "Room name must contain 1 to 80 characters."
    }, 400);
  }

  if (
    !authorKey ||
    authorKey.length < 32 ||
    authorKey.length > 100
  ) {
    return json(request, {
      error: "Valid author key is required."
    }, 400);
  }

  const ownerKeyHash =
    await hashAuthorKey(authorKey);
  const createdAt = new Date().toISOString();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomCode = generateRoomCode();
    const normalizedCode =
      normalizeRoomCode(roomCode);
    const codeHash =
      await hashAuthorKey(normalizedCode);

    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO rooms (
        name,
        code_hash,
        owner_key_hash,
        created_at
      ) VALUES (?, ?, ?, ?)
    `).bind(
      name,
      codeHash,
      ownerKeyHash,
      createdAt
    ).run();

    if (result.meta.changes > 0) {
      return json(request, {
        room: {
          id: result.meta.last_row_id,
          name,
          code: roomCode,
          createdAt
        }
      }, 201);
    }
  }

  return json(request, {
    error: "Private room could not be created."
  }, 500);
}

async function joinRoom(request, env) {
  const data = await request.json();
  const roomCode =
    String(data.code || "").trim();
  const room =
    await findRoomByCode(env, roomCode);

  if (!room) {
    return json(request, {
      error: "Private room not found or code is invalid."
    }, 403);
  }

  return json(request, {
    room: {
      id: room.id,
      name: room.name,
      code: roomCode,
      createdAt: room.created_at
    }
  });
}

async function getMessages(request, env, url) {
  const language = String(
    url.searchParams.get("language") || "hr"
  ).toLowerCase();

    if (!LANGUAGES.has(language)) {
    return json(request, {
      error: "Supported languages are hr, en, ru and it."
    }, 400);
  }

  const roomAccess =
    await resolveRoomAccess(request, env);

  if (roomAccess.error) {
    return roomAccess.error;
  }

  const room = roomAccess.room;
  const roomId = room ? Number(room.id) : 0;

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
        edited_at,
        room_id
      FROM messages
      WHERE COALESCE(room_id, 0) = ?
      ORDER BY id DESC
      LIMIT 100
    )
    ORDER BY id ASC
   `).bind(roomId).run();

    return json(request, {
    room: room
      ? {
          id: room.id,
          name: room.name,
          private: true
        }
      : {
          id: null,
          name: "Builder Chat",
          private: false
        },
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
      error: "Supported languages are hr, en, ru and it."
    }, 400);
  }

  const roomAccess =
    await resolveRoomAccess(request, env);

  if (roomAccess.error) {
    return roomAccess.error;
  }

  const room = roomAccess.room;
  const roomId = room ? Number(room.id) : 0;
  const duplicateSince =
    new Date(Date.now() - 10000).toISOString();

  const duplicateMessage = await env.DB.prepare(`
    SELECT id
    FROM messages
    WHERE username = ?
      AND text = ?
      AND language = ?
      AND COALESCE(room_id, 0) = ?
      AND created_at >= ?
    ORDER BY id DESC
    LIMIT 1
  `).bind(
    username,
    text,
    language,
    roomId,
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
      author_key_hash,
      room_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    username,
    text,
    language,
    translations.hr,
    translations.en,
    translations.ru,
    translations.it,
    createdAt,
    authorKeyHash,
    room ? room.id : null
  ).run();

  return json(request, {
    message: {
      id: result.meta.last_row_id,
      username,
      text,
      language,
      createdAt,
      authorKeyHash,
      roomId: room ? room.id : null,
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

    const roomAccess =
    await resolveRoomAccess(request, env);

  if (roomAccess.error) {
    return roomAccess.error;
  }

  const room = roomAccess.room;
  const requestedRoomId =
    room ? Number(room.id) : 0;


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

    const messageRoomId =
    existingMessage.room_id
      ? Number(existingMessage.room_id)
      : 0;

  if (messageRoomId !== requestedRoomId) {
    return json(request, {
      error: "Message not found in this room."
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
        AND COALESCE(room_id, 0) = ?
  `).bind(
    text,
    translations.hr,
    translations.en,
    translations.ru,
    translations.it,
    editedAt,
    messageId,
    requestedRoomId
  ).run();

  const updatedMessage = await env.DB.prepare(`
    SELECT *
    FROM messages
    WHERE id = ?
    AND COALESCE(room_id, 0) = ?
  `).bind(
    messageId,
    requestedRoomId
  ).first();

  return json(request, {
    message: toMessage(updatedMessage)
  });
}

async function getLatestMessage(request, env) {
  const latestMessage = await env.DB.prepare(`
    SELECT id
    FROM messages
    WHERE room_id IS NULL
    ORDER BY id DESC
    LIMIT 1
  `).first();

  return json(request, {
    latestMessageId:
      latestMessage?.id || 0
  });
}
async function getAppUpdate(request) {
  return json(request, {
    version: "1.1.2",
    apkUrl:
  "https://k3ram.com/downloads/kgcl-1.1.2.apk"
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
        request.method === "GET" &&
        url.pathname === "/api/app-update"
      ) {
        return await getAppUpdate(request);
      }

            if (
        request.method === "POST" &&
        url.pathname === "/api/accounts/register"
      ) {
        return await registerAccount(request, env);
      }

            if (
        request.method === "POST" &&
        url.pathname === "/api/accounts/login"
      ) {
        return await loginAccount(request, env);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/accounts/me"
      ) {
        return await getCurrentAccount(request, env);
      }


      if (
        request.method === "POST" &&
        url.pathname === "/setup"
      ) {
        await setupDatabase(env);

        return json(request, {
          status: "ready",
          tables: [
            "messages",
            "rooms",
            "accounts",
            "account_sessions"
        ]
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
        request.method === "POST" &&
        url.pathname === "/api/rooms"
      ) {
        return await createRoom(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/rooms/join"
      ) {
        return await joinRoom(request, env);
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