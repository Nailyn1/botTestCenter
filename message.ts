export async function sendTelegramMessage(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_GROUP_CHAT_ID;

  if (!token || !chatId) {
    console.error("Ошибка: Не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID/TELEGRAM_GROUP_CHAT_ID");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "HTML",
      }),
    });

    if (!response.ok) {
      console.error("Ошибка API Telegram:", await response.text());
    }
  } catch (error) {
    console.error("Сетевая ошибка при отправке в Telegram:", error);
  }
}
