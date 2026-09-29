"""
Предложка (Livegram -> группа) -> канал. Один юзербот на аккаунте с Premium.

Как работает:
  1. Livegram пересылает посты пользователей в вашу группу.
  2. Юзербот следит за этой группой, берёт картинку и подпись.
  3. Приводит картинку к 2800x1100, разбирает подпись, собирает пост по шаблону,
     ставит премиум-эмодзи на место каждого "ㅤ" и публикует в канал.
  4. Результат ("опубликовано" / что исправить) пишет ответом в группе.

Переменные окружения (на Render: Environment):
  API_ID, API_HASH   - с my.telegram.org
  SESSION_STRING     - получить один раз через make_session.py
  GROUP_ID           - id группы, куда Livegram шлёт сообщения (например -1001234567890)
  CHANNEL            - @username канала или его id
  EMOJI_ID           - id премиум-эмодзи

Хелперы (пишите в "Избранное" / в любой чат со своего аккаунта):
  * отправьте себе в "Избранное" премиум-эмодзи -> придёт его id
  * напишите .id в нужной группе -> сообщение заменится на id чата
"""
import asyncio
import io
import os
import re

from PIL import Image, ImageOps
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.types import MessageEntityCustomEmoji, MessageEntityTextUrl

# ---------------- НАСТРОЙКИ ----------------
API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
SESSION_STRING = os.environ["SESSION_STRING"]
GROUP_ID = int(os.getenv("GROUP_ID", "0"))
_channel = os.getenv("CHANNEL", "")
CHANNEL = int(_channel) if _channel.lstrip("-").isdigit() else _channel
EMOJI_ID = int(os.getenv("EMOJI_ID", "0"))

REQUIRED_SIZE = (2800, 1100)
MAX_CROP = 0.15  # максимум 15% картинки можно обрезать автоматически
LINK_TEXT = "@mybfgf.t.me"
LINK_URL = "http://mybfgf.t.me/"
FILLER = "ㅤ"  # на его месте будет премиум-эмодзи

# ---------------- ШАБЛОНЫ ----------------
HEAD = FILLER * 2 + " ⸝⸝ ☇ " + LINK_TEXT + " ᛝ ꒱ ꒱ ⋮ ۶ "
TAIL = " ֶָ֢.\n" + FILLER * 3 + "﹝𑣲 #{fandom} ୧"

TEMPLATE_SOLO = HEAD + "ТУПО {who} {kind} 一 {name}" + TAIL
TEMPLATE_PAIR = HEAD + "ТРУШНАЯ ПАРА 一 {name1} & {name2}" + TAIL

# ---------------- РАЗБОР ТЕКСТА ----------------
DASH = r"[一\-—–]"
STOP = r"\n\u0590-\u05FF.﹝#"  # где заканчивается имя
RE_SOLO = re.compile(
    rf"ТУПО\s+(МОЙ|МОЯ|МОИ)\s+(БФ|ГФ|ЭНБИФ)\s*{DASH}\s*([^{STOP}]+)", re.I
)
RE_PAIR = re.compile(
    rf"ТРУШНАЯ\s+ПАРА\s*{DASH}\s*([^&{STOP}]+?)\s*&\s*([^{STOP}]+)", re.I
)
RE_TAG = re.compile(r"#(\w+)")

EXAMPLE = (
    "Примеры:\n"
    "ТУПО МОЙ БФ 一 ИМЯ #фандом\n"
    "ТРУШНАЯ ПАРА 一 ИМЯ & ИМЯ #фандом"
)


def u16(s: str) -> int:
    """Длина строки в UTF-16 (в этих единицах Telegram считает offset)."""
    return len(s.encode("utf-16-le")) // 2


def parse_caption(text: str):
    """Возвращает (готовый_текст, None) или (None, сообщение_об_ошибке)."""
    tag = RE_TAG.search(text)
    if not tag:
        return None, "Не нашёл хештег фандома (например #genshin).\n\n" + EXAMPLE
    fandom = tag.group(1)

    m = RE_PAIR.search(text)
    if m:
        n1, n2 = m.group(1).strip().upper(), m.group(2).strip().upper()
        if not n1 or not n2:
            return None, "Не смог прочитать имена пары.\n\n" + EXAMPLE
        return TEMPLATE_PAIR.format(name1=n1, name2=n2, fandom=fandom), None

    m = RE_SOLO.search(text)
    if m:
        who, kind, name = m.group(1).upper(), m.group(2).upper(), m.group(3).strip().upper()
        if not name:
            return None, "Не смог прочитать имя.\n\n" + EXAMPLE
        return TEMPLATE_SOLO.format(who=who, kind=kind, name=name, fandom=fandom), None

    return None, "Не распознал оформление.\n\n" + EXAMPLE


def build_entities(text: str):
    """Премиум-эмодзи на месте каждого ㅤ + ссылка на канал."""
    entities = []
    offset = 0
    for ch in text:
        if ch == FILLER:
            entities.append(MessageEntityCustomEmoji(offset=offset, length=1, document_id=EMOJI_ID))
        offset += u16(ch)
    i = text.find(LINK_TEXT)
    if i != -1:
        entities.append(
            MessageEntityTextUrl(offset=u16(text[:i]), length=u16(LINK_TEXT), url=LINK_URL)
        )
    return entities


def process_image(data: bytes):
    """
    Приводит картинку к 2800x1100.
    Возвращает (bytes, предупреждение | None, None) или (None, None, ошибка).
    """
    try:
        im = Image.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im).convert("RGB")
    except Exception:
        return None, None, "Не смог открыть картинку. Нужен PNG/JPG."

    w, h = im.size
    tw, th = REQUIRED_SIZE
    if (w, h) == REQUIRED_SIZE:
        out = io.BytesIO()
        im.save(out, "PNG")
        return out.getvalue(), None, None

    target = tw / th
    ratio = w / h
    lost = 1 - (target / ratio if ratio > target else ratio / target)
    if lost > MAX_CROP:
        return None, None, (
            f"Размер {w}×{h} слишком далёк от 2800×1100 - при обрезке потеряется "
            f"{lost:.0%} картинки. Нужно подогнать пропорции (примерно 28:11)."
        )

    fitted = ImageOps.fit(im, REQUIRED_SIZE, Image.LANCZOS, centering=(0.5, 0.5))
    warning = None
    if w < tw:
        warning = (
            f"Исходник {w}×{h} меньше нужного, картинку растянули до 2800×1100 - "
            "качество ниже. Лучше присылать оригинал файлом."
        )
    out = io.BytesIO()
    fitted.save(out, "PNG")
    return out.getvalue(), warning, None


# ---------------- КЛИЕНТ ----------------
client = TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH)


async def on_submission(event):
    is_image_file = event.document and (event.document.mime_type or "").startswith("image/")
    if not (event.photo or is_image_file):
        return  # не предложка (текст, служебные сообщения) - молчим

    problems = []
    data = await event.download_media(bytes)
    result, warning, err = process_image(data)
    if err:
        problems.append(err)

    final_text, err = parse_caption(event.raw_text or "")
    if err:
        problems.append(err)

    if problems:
        await event.reply("Не опубликовано:\n\n" + "\n\n".join(problems))
        return

    file = io.BytesIO(result)
    file.name = "post.png"
    await client.send_file(
        CHANNEL,
        file,
        caption=final_text,
        formatting_entities=build_entities(final_text),
        force_document=False,
    )
    await event.reply("Опубликовано ✅" + (f"\n\n⚠️ {warning}" if warning else ""))


@client.on(events.NewMessage(chats="me", outgoing=True))
async def emoji_id_helper(event):
    """Отправьте себе в Избранное премиум-эмодзи - получите его id."""
    ids = [
        e.document_id
        for e in (event.message.entities or [])
        if isinstance(e, MessageEntityCustomEmoji)
    ]
    if ids:
        await event.reply("id эмодзи: " + ", ".join(f"`{i}`" for i in ids))


@client.on(events.NewMessage(outgoing=True, pattern=r"^\.id$"))
async def chat_id_helper(event):
    """Напишите .id в группе - сообщение заменится на id этого чата."""
    await event.edit(f"id чата: `{event.chat_id}`")


async def main():
    await client.start()
    me = await client.get_me()
    if not getattr(me, "premium", False):
        print("ВНИМАНИЕ: у аккаунта нет Telegram Premium - эмодзи не отобразятся!")
    if GROUP_ID:
        client.add_event_handler(on_submission, events.NewMessage(chats=GROUP_ID, incoming=True))
        print(f"Слежу за группой {GROUP_ID}, публикую в {CHANNEL}.")
    else:
        print("GROUP_ID не задан: работают только хелперы (.id и id эмодзи).")
    await client.run_until_disconnected()


if __name__ == "__main__":
    asyncio.run(main())
