const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { sample } = require('lodash'); // Usado para respostas personalizadas de sucesso

// --- Configuração ---
const GASTOS_FILE_PATH = path.join(__dirname, 'gastos.txt');
const SESSION_DIR = path.join(__dirname, 'baileys_auth_info');

// --- Estado e Armazenamento ---
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });
store?.readFromFile(path.join(SESSION_DIR, 'baileys_store.json'));
setInterval(() => {
    store?.writeToFile(path.join(SESSION_DIR, 'baileys_store.json'));
}, 10_000);

// Objeto para guardar o estado da confirmação por usuário
// Estrutura: { "chatId": { type: 'expense_confirm' | 'category_confirm' | 'clear_confirm', ...data } }
let userConfirmationState = {};

// Objeto para armazenar dados da última despesa adicionada para confirmação de categoria
// Estrutura: { "chatId": { timestamp: Date, value: number, description: string, suggestedCategory: string } }
let lastAddedExpenseData = {};


// --- Mapeamento de Categorias (Exemplo - Personalize!) ---
const categoryMap = {
    'mercado': 'Supermercado',
    'compra': 'Supermercado',
    'padaria': 'Alimentação',
    'restaurante': 'Alimentação',
    'almoco': 'Alimentação',
    'jantar': 'Alimentação',
    'pizza': 'Alimentação',
    'lanche': 'Alimentação',
    'transporte': 'Transporte',
    'uber': 'Transporte',
    'taxi': 'Transporte',
    'gasolina': 'Automóvel',
    'combustivel': 'Automóvel',
    'cinema': 'Entretenimento',
    'filme': 'Entretenimento',
    'role': 'Entretenimento',
    'roupa': 'Compras',
    'sapato': 'Compras',
    'eletronico': 'Compras',
    'conta': 'Contas Fixas', // Exemplo
    'aluguel': 'Moradia', // Exemplo
    'internet': 'Serviços', // Exemplo
};

function suggestCategory(description) {
    const lowerDescription = description.toLowerCase();
    for (const keyword in categoryMap) {
        if (lowerDescription.includes(keyword)) {
            return categoryMap[keyword];
        }
    }
    return 'Outros'; // Categoria padrão
}

// --- Respostas Personalizadas (Exemplo - Expanda!) ---
const successPhrases = [
    "🎉 Boa! Gasto registrado com sucesso! 📝",
    "✅ Anotei esse gasto pra você. 😉",
    "💰 Ok, R$${value} em ${description} registrado. Contabilidade em dia! 💪",
    "📝 Gasto adicionado! Cuidado com o bolso! 😅",
    "💸 Registrado! Que venha o próximo! 😂"
];

function getRandomSuccessPhrase(value, description) {
    const phrase = sample(successPhrases);
    return phrase
        .replace('${value}', value.toFixed(2).replace('.', ','))
        .replace('${description}', description);
}


// --- Helper function to read and parse expenses ---
// Formato: timestamp;value;description;category\n
const readExpensesFromFile = () => {
    if (!fs.existsSync(GASTOS_FILE_PATH)) {
        return [];
    }
    const fileContent = fs.readFileSync(GASTOS_FILE_PATH, 'utf-8');
    if (!fileContent.trim()) {
        return []; // Handle empty file
    }
    return fileContent.trim().split('\n').map(line => {
        const parts = line.split(';');
        if (parts.length < 3) return null; // Skip invalid lines (need at least timestamp, value, description)
        const [timestamp, rawValue, description, category] = parts;
        return {
            timestamp: new Date(timestamp),
            value: parseFloat(rawValue),
            description: description || 'Sem descrição', // Default description
            category: category || 'Outros' // Default category
        };
    }).filter(item => item !== null && !isNaN(item.value)); // Filter out invalid lines and values
};

// Helper function to write expenses back to file (used for category updates)
const writeExpensesToFile = (expenses) => {
    const lines = expenses.map(exp =>
        `${exp.timestamp.toISOString()};${exp.value.toFixed(2)};${exp.description};${exp.category}`
    );
    // Ensure a newline at the end of the file
    fs.writeFileSync(GASTOS_FILE_PATH, lines.join('\n') + '\n', 'utf-8');
};


// --- Main Baileys Connection Logic ---
async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Usando Baileys v${version.join('.')}, É a mais recente: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        getMessage: async key => {
            if (store) {
                const msg = await store.loadMessage(key.remoteJid, key.id)
                return msg?.message || undefined
            }
            return { conversation: 'hello' }
        }
    });

    store?.bind(sock.ev);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada devido a ', lastDisconnect.error, ', reconectando ', shouldReconnect);
            // Clear state on disconnects that aren't logout
            if(shouldReconnect) {
                 userConfirmationState = {};
                 lastAddedExpenseData = {};
            }
            if (shouldReconnect) {
                startSock();
            } else {
                console.log("Desconectado. Você foi desconectado e precisa escanear o QR Code novamente.");
                userConfirmationState = {}; // Clear state on explicit logout
                lastAddedExpenseData = {};
            }
        } else if (connection === 'open') {
            console.log('Conexão aberta! Robô pronto para receber mensagens.');
            // Notificações agendadas e outras automações foram removidas.
        }

        if (qr) {
            // QR Code is printed by printQRInTerminal: true
        }
    });


    // --- Message Handling ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) {
            return;
        }

        const chatId = msg.key.remoteJid;
        const messageText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const lowerCaseText = messageText.toLowerCase();

         // --- Handle pending confirmation (Expecting Text Response "sim" or "não") ---
        if (userConfirmationState[chatId]) {
             const pending = userConfirmationState[chatId];

             if (pending.type === 'expense_confirm') {
                 if (lowerCaseText === 'sim' || lowerCaseText === 's') {
                     // User confirmed the expense
                    let fileSavedSuccessfully = false;
                    const timestamp = new Date(); // Get timestamp early

                    try {
                        // --- Tenta salvar o gasto no arquivo ---
                        const record = `${timestamp.toISOString()};${pending.value.toFixed(2)};${pending.description};Outros\n`;
                        fs.appendFileSync(GASTOS_FILE_PATH, record);
                        fileSavedSuccessfully = true; // Mark success
                    } catch (fileSaveError) {
                        // --- Captura ERROS APENAS do salvamento do arquivo ---
                        console.error("Erro REAL ao salvar no arquivo:", fileSaveError);
                        await sock.sendMessage(chatId, { text: '⚠️ Ocorreu um erro *ao tentar salvar* o gasto no arquivo. Tente novamente.' });
                        // Limpa o estado, pois o primeiro passo falhou
                        delete userConfirmationState[chatId];
                        delete lastAddedExpenseData[chatId];
                        return; // Sai da função, não continua
                    }

                    // --- Se o arquivo foi salvo com sucesso, tenta enviar a próxima mensagem ---
                    if (fileSavedSuccessfully) {
                        try {
                            // Armazena dados para a próxima etapa de confirmação de categoria
                            lastAddedExpenseData[chatId] = {
                                timestamp, // Usa o timestamp real do salvamento
                                value: pending.value,
                                description: pending.description,
                                suggestedCategory: pending.suggestedCategory
                            };

                            // Transiciona o estado para confirmação de categoria
                            userConfirmationState[chatId] = { type: 'category_confirm' };

                            // Prepara e envia a mensagem de confirmação de categoria (texto)
                            const categoryConfirmationMessage = getRandomSuccessPhrase(pending.value, pending.description) + `\n\nQuer classificar como *${pending.suggestedCategory}*? (Responda "sim" ou "não")`;
                            await sock.sendMessage(chatId, { text: categoryConfirmationMessage });

                            // Se chegou até aqui, tudo ocorreu bem com o primeiro passo e o envio da próxima mensagem.
                            // O estado userConfirmationState[chatId] agora é 'category_confirm', esperando a próxima resposta.

                        } catch (sendMessageError) {
                            // --- Captura ERROS APENAS do envio da mensagem de confirmação de categoria ---
                            console.error("Erro ao enviar mensagem de confirmação de categoria:", sendMessageError);

                            // Informa ao usuário que o gasto FOI salvo, mas houve problema no próximo passo
                            await sock.sendMessage(chatId, { text: `✅ Gasto de R$${pending.value.toFixed(2).replace('.', ',')} com "${pending.description}" foi registrado, mas houve um erro ao pedir a confirmação da categoria. A categoria ficou como "Outros".` });

                            // Limpa o estado, pois a etapa de categoria não pode continuar normalmente
                            delete userConfirmationState[chatId];
                            delete lastAddedExpenseData[chatId];
                        }
                    }
                    // O estado não é deletado aqui, é gerenciado nas etapas seguintes ou nos catch blocks.


                 } else if (['não', 'nao', 'n'].includes(lowerCaseText)) {
                     // User cancelled the expense
                     await sock.sendMessage(chatId, { text: '❌ Registro de gasto cancelado.' });
                     delete userConfirmationState[chatId];
                     delete lastAddedExpenseData[chatId]; // Clean up any potential partial data
                 } else {
                     // Invalid response while expense confirmation is pending
                     await sock.sendMessage(chatId, { text: '🤔 Resposta inválida. Por favor, responda com "sim" ou "não" para a confirmação do gasto.' });
                     return; // Don't delete state yet if response is invalid
                 }
             } else if (pending.type === 'category_confirm') {
                  const expenseData = lastAddedExpenseData[chatId];

                  if (!expenseData) {
                      await sock.sendMessage(chatId, { text: '❌ Ocorreu um erro ao processar a confirmação da categoria. Por favor, registre o gasto novamente.' });
                      delete userConfirmationState[chatId];
                      return; // Exit
                  }

                  if (lowerCaseText === 'sim' || lowerCaseText === 's') {
                      // User confirmed the suggested category
                      try {
                         let expenses = readExpensesFromFile();
                         let updated = false;
                         // Find the expense we just added by timestamp, value, description
                         for (let i = expenses.length - 1; i >= 0; i--) { // Search from the end (most recent)
                             const exp = expenses[i];
                             // Compare using timestamp (ISO string for consistency), value, and description
                             if (exp.timestamp.toISOString() === expenseData.timestamp.toISOString() &&
                                 exp.value === expenseData.value &&
                                  exp.description === expenseData.description &&
                                  exp.category === 'Outros' // Only update if it's still the default
                                 ) {
                                 expenses[i].category = expenseData.suggestedCategory;
                                 updated = true;
                                 break; // Found and updated the last added expense
                             }
                         }

                         if (updated) {
                             writeExpensesToFile(expenses); // Rewrite the file with updated category
                             await sock.sendMessage(chatId, { text: `✅ Gasto agora classificado como *${expenseData.suggestedCategory}*! 🎉` });
                         } else {
                              await sock.sendMessage(chatId, { text: `⚠️ Não foi possível encontrar o gasto para classificar. Pode ser que ele já tenha uma categoria ou houve um problema.` });
                          }


                      } catch (err) {
                          console.error("Erro ao atualizar categoria no arquivo:", err);
                          await sock.sendMessage(chatId, { text: '⚠️ Ocorreu um erro ao salvar a categoria. Tente novamente.' });
                      } finally {
                          delete userConfirmationState[chatId];
                          delete lastAddedExpenseData[chatId];
                      }

                  } else if (['não', 'nao', 'n'].includes(lowerCaseText)) {
                      // User rejected the suggested category
                      await sock.sendMessage(chatId, { text: '👍 Ok, a categoria foi mantida como "Outros".' });
                      delete userConfirmationState[chatId];
                      delete lastAddedExpenseData[chatId];
                  } else {
                      // Invalid response while category confirmation is pending
                      await sock.sendMessage(chatId, { text: '🤔 Resposta inválida. Por favor, responda com "sim" ou "não" para confirmar a categoria.' });
                      return; // Don't clear state
                  }
             } else if (pending.type === 'clear_confirm') {
                 if (lowerCaseText === 'sim' || lowerCaseText === 's') {
                      try {
                         if (fs.existsSync(GASTOS_FILE_PATH)) {
                              const fileContent = fs.readFileSync(GASTOS_FILE_PATH, 'utf-8');
                             if (fileContent.trim().length > 0) {
                                 fs.unlinkSync(GASTOS_FILE_PATH); // Delete the file
                                 await sock.sendMessage(chatId, { text: '🧹 Todos os gastos foram apagados.' });
                             } else {
                                 await sock.sendMessage(chatId, { text: '📂 O arquivo de gastos já estava vazio.' });
                             }
                         } else {
                              await sock.sendMessage(chatId, { text: '📂 Nenhum gasto encontrado para apagar.' });
                         }
                     } catch (err) {
                         console.error("Erro ao apagar arquivo:", err);
                         await sock.sendMessage(chatId, { text: '⚠️ Ocorreu um erro ao apagar os dados.' });
                     } finally {
                         delete userConfirmationState[chatId];
                     }
                 } else if (['não', 'nao', 'n'].includes(lowerCaseText)) {
                      await sock.sendMessage(chatId, { text: '👍 A limpeza foi cancelada.' });
                      delete userConfirmationState[chatId];
                 } else {
                      // Invalid response while clear confirmation is pending
                      await sock.sendMessage(chatId, { text: '🤔 Resposta inválida. Por favor, responda com "sim" ou "não" para confirmar a limpeza.' });
                      return; // Don't clear state
                 }
             } else {
                 // Should not happen if state types are managed correctly
                 console.warn(`Unhandled confirmation state type: ${pending.type}`);
                 delete userConfirmationState[chatId]; // Clear unknown state
                 return; // Stop processing
             }

             // If a valid confirmation response was handled, clear the state
             // Note: State is only deleted IF the response was 'sim' or 'não' within their respective blocks.
             // Invalid responses keep the state pending.
             // The deletion logic is now handled inside each sim/não path or catch block.
             // No need for a general delete here.


             return; // Stop processing after handling a confirmation text response
        }


        // --- Process Commands if no confirmation is pending ---

        // /ajuda - Show available commands
        if (lowerCaseText === '/ajuda') {
            const helpMessage = `🤖 *Comandos Disponíveis:*\n\n` +
                                `💰 *Registrar Gasto:*\n` +
                                `   Use o formato \`gastei [valor] na/no/com [descrição]\`\n` +
                                `   _Ex: gastei 25,50 no cinema_\n` +
                                `   _Ex: gastei 100 com supermercado_\n\n` +
                                `📊 *Relatórios:*\n` +
                                `   \`/relatorio\` - Mostra todos os gastos por mês/dia, totais mensais e ranking de categorias.\n` +
                                `   \`/hoje\` - Mostra apenas os gastos de hoje com total.\n` +
                                `   \`/semana\` - Mostra os gastos dos últimos 7 dias com total.\n` +
                                `   \`/total\` - Mostra o valor total de todos os gastos registrados.\n\n` +
                                `🗑️ *Gerenciamento:*\n` +
                                `   \`/limpar\` - Apaga TODOS os gastos registrados (pedirá confirmação). Responda "sim" ou "não".\n\n` +
                                `❓ \`/ajuda\` - Mostra esta mensagem.`;
            await sock.sendMessage(chatId, { text: helpMessage });
            return;
        }

         // /total - Show total expenses
         if (lowerCaseText === '/total') {
            try {
                const expenses = readExpensesFromFile();
                if (expenses.length === 0) {
                    await sock.sendMessage(chatId, { text: '📂 Nenhum gasto encontrado ainda.' });
                    return;
                }

                const total = expenses.reduce((sum, expense) => sum + expense.value, 0);
                const totalFormatted = total.toFixed(2).replace('.', ',');
                await sock.sendMessage(chatId, { text: `📈 *Total de Gastos Registrados:*\n\n💸 R$${totalFormatted}` });

            } catch (err) {
                console.error("Erro ao calcular total:", err);
                await sock.sendMessage(chatId, { text: '⚠️ Ocorreu um erro ao calcular o total de gastos.' });
            }
            return;
         }

         // /hoje - Show expenses for today
         if (lowerCaseText === '/hoje') {
            try {
                const expenses = readExpensesFromFile();
                if (expenses.length === 0) {
                    await sock.sendMessage(chatId, { text: '📂 Nenhum gasto encontrado ainda.' });
                    return;
                }

                const today = new Date();
                today.setHours(0, 0, 0, 0); // Set to the beginning of the day

                const todayExpenses = expenses.filter(expense => {
                    const expenseDate = new Date(expense.timestamp);
                    expenseDate.setHours(0, 0, 0, 0);
                    return expenseDate.getTime() === today.getTime();
                }).sort((a, b) => a.timestamp - b.timestamp); // Sort by time for the day

                if (todayExpenses.length === 0) {
                    await sock.sendMessage(chatId, { text: '🗓️ Nenhum gasto registrado para hoje.' });
                    return;
                }

                let reportMessage = `🗓️ *Gastos de Hoje - ${today.toLocaleDateString('pt-BR')}*\n\n`;
                 let totalToday = 0;

                 for (const expense of todayExpenses) {
                     const valueFormatted = expense.value.toFixed(2).replace('.', ',');
                     reportMessage += `   📌 R$${valueFormatted} com ${expense.description} *(Categoria: ${expense.category})*\n`;
                     totalToday += expense.value;
                 }

                 const totalTodayFormatted = totalToday.toFixed(2).replace('.', ',');
                 reportMessage += `\n----------------------------\n`;
                 reportMessage += `💸 *Total de Hoje:* R$${totalTodayFormatted}`;


                await sock.sendMessage(chatId, { text: reportMessage.trim() });

            } catch (err) {
                console.error("Erro ao gerar relatório de hoje:", err);
                await sock.sendMessage(chatId, { text: '⚠️ Ocorreu um erro ao gerar o relatório de hoje.' });
            }
            return;
         }


         // /semana - Show expenses for the last 7 days
         if (lowerCaseText === '/semana') {
            try {
                const expenses = readExpensesFromFile();
                if (expenses.length === 0) {
                    await sock.sendMessage(chatId, { text: '📂 Nenhum gasto encontrado ainda.' });
                    return;
                }

                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const sevenDaysAgo = new Date(today);
                sevenDaysAgo.setDate(today.getDate() - 6); // Include today, so 7 days total
                sevenDaysAgo.setHours(0, 0, 0, 0); // Ensure start of the day

                 const weekExpenses = expenses.filter(expense => {
                    const expenseDate = new Date(expense.timestamp);
                     expenseDate.setHours(0, 0, 0, 0);
                    return expenseDate >= sevenDaysAgo && expenseDate <= today;
                }).sort((a, b) => a.timestamp - b.timestamp); // Sort by date and time

                 if (weekExpenses.length === 0) {
                    await sock.sendMessage(chatId, { text: '🗓️ Nenhum gasto registrado nos últimos 7 dias.' });
                    return;
                }

                 let reportMessage = `🗓️ *Gastos dos Últimos 7 Dias:*\n\n`;
                 const reportData = {}; // To group by day

                 for (const expense of weekExpenses) {
                    const day = expense.timestamp.toLocaleDateString('pt-BR');
                     if (!reportData[day]) reportData[day] = [];
                     reportData[day].push(expense);
                 }

                 let totalWeek = 0;
                 const sortedDays = Object.keys(reportData).sort((a, b) => {
                     // Sort dates correctly (dd/mm/yyyy)
                     const [dayA, monthA, yearA] = a.split('/');
                     const [dayB, monthB, yearB] = b.split('/');
                     const dateA = new Date(yearA, monthA - 1, dayA); // Month is 0-indexed in JS Date
                     const dateB = new Date(yearB, monthB - 1, dayB);
                     return dateA - dateB;
                 });


                 for (const day of sortedDays) {
                     reportMessage += `📅 *${day}*\n`;
                     let totalDay = 0;
                     for (const expense of reportData[day]) {
                        const valueFormatted = expense.value.toFixed(2).replace('.', ',');
                        reportMessage += `   📌 R$${valueFormatted} com ${expense.description} *(Categoria: ${expense.category})*\n`;
                        totalDay += expense.value;
                     }
                     const totalDayFormatted = totalDay.toFixed(2).replace('.', ',');
                     reportMessage += `   _Total do dia: R$${totalDayFormatted}_\n`;
                     totalWeek += totalDay;
                     reportMessage += `\n`; // Add a line break between days
                 }

                 const totalWeekFormatted = totalWeek.toFixed(2).replace('.', ',');
                 reportMessage += `----------------------------\n`;
                 reportMessage += `💸 *Total da Semana:* R$${totalWeekFormatted}`;


                await sock.sendMessage(chatId, { text: reportMessage.trim() });

            } catch (err) {
                console.error("Erro ao gerar relatório da semana:", err);
                await sock.sendMessage(chatId, { text: '⚠️ Ocorreu um erro ao gerar o relatório da semana.' });
            }
            return;
         }


        // /relatorio - Show full report
         if (lowerCaseText === '/relatorio') {
            try {
                const expenses = readExpensesFromFile();
                 if (expenses.length === 0) {
                    await sock.sendMessage(chatId, { text: '📂 Nenhum gasto encontrado ainda.' });
                    return;
                }

                const reportData = {}; // Group by Month -> Day -> Expenses
                const monthlyTotals = {}; // Group by Month -> Total
                const categoryTotals = {}; // Group by Category -> Total

                for (const expense of expenses) {
                    const date = expense.timestamp;
                    const monthYear = date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
                    const day = date.toLocaleDateString('pt-BR');
                    const category = expense.category || 'Outros'; // Ensure category exists

                    // Group by Month/Day
                    if (!reportData[monthYear]) reportData[monthYear] = {};
                    if (!reportData[monthYear][day]) reportData[monthYear][day] = [];
                    const valueFormatted = expense.value.toFixed(2).replace('.', ',');
                    reportData[monthYear][day].push(`     📌 R$${valueFormatted} com ${expense.description} *(Categoria: ${category})*`);

                    // Calculate Monthly Totals
                    if (!monthlyTotals[monthYear]) monthlyTotals[monthYear] = 0;
                    monthlyTotals[monthYear] += expense.value;

                    // Calculate Category Totals
                    if (!categoryTotals[category]) categoryTotals[category] = 0;
                    categoryTotals[category] += expense.value;
                }

                let reportMessage = '📊 *Relatório de Gastos:*\n\n';

                // Sort months chronologically
                const sortedMonths = Object.keys(reportData).sort((a, b) => {
                     const monthOrder = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
                     const [ma, ya] = a.split(' ');
                     const [mb, yb] = b.split(' ');
                     // Handle potential "de" in month names (e.g., "dezembro de 2023")
                     const monthAIndex = monthOrder.indexOf(ma.toLowerCase());
                     const monthBIndex = monthOrder.indexOf(mb.toLowerCase());
                     const yearA = parseInt(ya);
                     const yearB = parseInt(yb);

                     if (yearA !== yearB) return yearA - yearB;
                     return monthAIndex - monthBIndex;
                });


                for (const month of sortedMonths) {
                    reportMessage += `🗓️ *${month}*\n`;

                     // Sort days chronologically
                     const days = Object.keys(reportData[month]).sort((a, b) => {
                         const [dayA, monthA, yearA] = a.split('/');
                         const [dayB, monthB, yearB] = b.split('/');
                         const dateA = new Date(yearA, monthA - 1, dayA); // Month is 0-indexed in JS Date
                         const dateB = new Date(yearB, monthB - 1, dayB);
                         return dateA - dateB;
                     });


                    for (const day of days) {
                        reportMessage += `\n📅 *${day}*\n`;
                        for (const entry of reportData[month][day]) {
                            reportMessage += `${entry}\n`;
                        }
                    }

                     // Add monthly total
                     const monthlyTotalFormatted = monthlyTotals[month].toFixed(2).replace('.', ',');
                     reportMessage += `\n💰 *Total em ${month}:* R$${monthlyTotalFormatted}\n`;


                    reportMessage += `\n============================\n\n`;
                }

                // --- Category Ranking ---
                const sortedCategories = Object.entries(categoryTotals)
                    .sort(([, totalA], [, totalB]) => totalB - totalA); // Sort by total descending

                if (sortedCategories.length > 0) {
                     reportMessage += `🏆 *Ranking de Categorias:*\n`;
                     for (let i = 0; i < sortedCategories.length; i++) {
                         const [category, total] = sortedCategories[i];
                         reportMessage += `${i + 1}. ${category} – R$${total.toFixed(2).replace('.', ',')}\n`;
                     }
                    reportMessage += `\n`;
                }


                await sock.sendMessage(chatId, { text: reportMessage.trim() });
            } catch (err) {
                console.error("Erro ao gerar relatório:", err);
                await sock.sendMessage(chatId, { text: '⚠️ Ocorreu um erro ao gerar o relatório.' });
            }
            return;
         }

         // /limpar - Start confirmation for clearing data
         if (lowerCaseText === '/limpar') {
            // Check if there are actually expenses to clear
             const expenses = readExpensesFromFile();
             if (expenses.length === 0) {
                  await sock.sendMessage(chatId, { text: '📂 Nenhum gasto encontrado para apagar.' });
                  return;
             }

             userConfirmationState[chatId] = { type: 'clear_confirm' };

             // Send confirmation message expecting text response
            const clearConfirmationMessage = '⚠️ *ATENÇÃO:* Você tem certeza que deseja apagar TODOS os gastos registrados?\nEsta ação não pode ser desfeita.\n\n_(Responda com "sim" para confirmar ou "não" para cancelar)_';

             await sock.sendMessage(chatId, { text: clearConfirmationMessage });
             return; // Stop processing, waiting for confirmation
         }


        // --- Handle new expense entry (if no confirmation is pending and not a command) ---
        // Regex with validations
        const expenseRegex = /^gastei\s+(\d+(?:,\d{1,2})?)\s+(?:na|no|com)\s+(.+)$/i;
        const match = messageText.match(expenseRegex);

        if (match) {
            const rawValue = match[1].replace(',', '.');
            const value = parseFloat(rawValue);
            const description = match[2].trim();
            const suggestedCategory = suggestCategory(description); // Suggest category

            if (!isNaN(value) && description) {
                // Store state for the first confirmation step (confirming the expense details)
                userConfirmationState[chatId] = { type: 'expense_confirm', value, description, suggestedCategory };

                const formattedValue = value.toFixed(2).replace('.', ',');
                const today = new Date();
                const formattedDate = today.toLocaleDateString('pt-BR');

                 // Create text message for expense confirmation
                 const expenseConfirmationMessage = `📌 *Confirmação de Gasto:*\n\nDescrição: *${description.charAt(0).toUpperCase() + description.slice(1)}*\nValor: 💸 R$${formattedValue}\nData: 📆 ${formattedDate}\n\nIsso está correto?\n\n_(Responda com "sim" ou "não")_`;

                await sock.sendMessage(chatId, { text: expenseConfirmationMessage });

            } else {
                 await sock.sendMessage(chatId, { text: '❌ Formato inválido para registrar gasto. Use: `gastei [valor] na/no/com [descrição]`.' });
            }
        }
        // A resposta padrão para mensagens que não são comandos ou 'gastei' foi removida.
    });


    // Adiciona um listener para fechar a conexão de forma graciosa
    process.on('SIGINT', async () => {
        console.log("Desligando o robô...");
        await sock.logout();
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        console.log("Desligando o robô (SIGTERM)...");
        await sock.logout();
        process.exit(0);
    });
}

// Ensure the session directory exists
if (!fs.existsSync(SESSION_DIR)){
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

startSock().catch(err => {
    console.error("Erro ao iniciar o socket:", err);
    process.exit(1); // Exit if starting fails
});