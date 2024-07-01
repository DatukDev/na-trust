const axios = require('axios');
const mysql = require('mysql2/promise');
const moment = require('moment');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dbConfig = require('./dbConfig');

const botToken = '6891618539:AAGPjhQlVE-urPq4NNaKCut-H1aiKuE8soY';

const fetchCsrfToken = async () => {
    try {
        const response = await axios.get('https://trustpositif.kominfo.go.id/', {
            httpsAgent: new https.Agent({
                rejectUnauthorized: false // Bypass SSL verification
            })
        });
        const csrfToken = response.data.match(/name="csrf_token" value="(.+?)"/)[1];
        return csrfToken;
    } catch (error) {
        console.error('Error fetching CSRF token:', error.message);
        throw error;
    }
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const sendTelegramMessage = async (chatId, message) => {
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error('Error sending Telegram message:', error.response ? error.response.data : error.message);
    }
};

const getNotifiedDomains = (username) => {
    const filePath = path.resolve(__dirname, `${username}_notified_domains.txt`);
    if (!fs.existsSync(filePath)) {
        return new Set();
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return new Set(data.split('\n').filter(domain => domain));
};

const addNotifiedDomain = (username, domain) => {
    const filePath = path.resolve(__dirname, `${username}_notified_domains.txt`);
    fs.appendFileSync(filePath, `${domain}\n`);
};

const checkDomains = async () => {
    const chalk = await import('chalk'); // Dynamic import for chalk

    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        console.log('Connected to the database.');

        while (true) {
            const [domains] = await connection.execute('SELECT domain, username, brand FROM check_nawala');

            if (domains.length === 0) {
                console.log('No domains found in the database.');
                return;
            }

            for (let index = 0; index < domains.length; index++) {
                const row = domains[index];
                const { domain, username, brand } = row;

                const notifiedDomains = getNotifiedDomains(username);

                if (notifiedDomains.has(domain)) {
                    console.log(`Domain ${domain} has already been notified. Skipping...`);
                    continue;
                }

                try {
                    const csrfToken = await fetchCsrfToken();

                    const response = await axios.post('https://trustpositif.kominfo.go.id/Rest_server/getrecordsname_home', {
                        csrf_token: csrfToken,
                        name: domain
                    }, {
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        httpsAgent: new https.Agent({
                            rejectUnauthorized: false // Bypass SSL verification
                        })
                    });

                    const data = response.data;
                    for (let value of data.values) {
                        const status = value.Status === 'Ada' ? 'Nawala' : 'Aman';
                        const lastCheck = moment().format('YYYY-MM-DD HH:mm:ss');

                        await connection.execute(
                            'UPDATE check_nawala SET status = ?, last_check = ? WHERE domain = ?',
                            [status, lastCheck, value.Domain]
                        );

                        const statusColor = status === 'Nawala' ? chalk.default.red(status) : chalk.default.green(status);
                        const lastCheckColor = chalk.default.yellow(lastCheck);

                        console.log(`[ Domain Ke-${index + 1} ] Processed domain: ${value.Domain} | Status: [ ${statusColor} ] | Last Check: [ ${lastCheckColor} ]`);

                        if (status === 'Nawala') {
                            // Fetch user details for notification
                            const [user] = await connection.execute(
                                'SELECT chat_id FROM user WHERE username = ?',
                                [username]
                            );

                            if (user.length > 0) {
                                const chatId = user[0].chat_id;
                                if (!chatId) {
                                    console.error(`Chat ID not found for user ${username}`);
                                    continue;
                                }
                                const message = `Halo Bosqu DOMAIN web ${brand} anda terdeteksi NAWALA\nURL : ${domain}`;
                                await sendTelegramMessage(chatId, message);
                                addNotifiedDomain(username, domain);
                            } else {
                                console.error(`User not found for username ${username}`);
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Error processing domain ${domain}:`, error.message);
                }
            }

            // Wait for 1 minute before rechecking
            await delay(0); // Set to 60000 for 1 minute delay
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
};

checkDomains();
