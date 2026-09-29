"""
Запустите ОДИН РАЗ на своём компьютере: python make_session.py
Скрипт спросит API_ID, API_HASH, номер телефона и код из Telegram,
после чего выдаст длинную строку SESSION_STRING.
Вставьте её в переменные окружения на Render. Никому её не показывайте:
с ней можно войти в ваш аккаунт.
"""
from telethon.sessions import StringSession
from telethon.sync import TelegramClient

api_id = int(input("API_ID: "))
api_hash = input("API_HASH: ").strip()

with TelegramClient(StringSession(), api_id, api_hash) as client:
    print("\nВаш SESSION_STRING:\n")
    print(client.session.save())
