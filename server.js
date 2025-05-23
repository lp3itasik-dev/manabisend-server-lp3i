require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const qrcode = require('qrcode');
const axios = require('axios');
const http = require('http');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const app = express();

const { PORT, API_ACCOUNT, API_CHAT } = process.env;

const { Server } = require('socket.io');
const { Client, MessageMedia, NoAuth, LocalAuth } = require('whatsapp-web.js')
const { phoneNumberFormatter, apiHistoryDatabase } = require('./helpers/formatter');

const dbPath = path.join(__dirname, 'database.db');
const exists = fs.existsSync(dbPath);

const server = http.createServer(app);

const io = new Server(server);

const client = new Client({
  restartOnAuthFail: true,
  authStrategy: new NoAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  },
});

const db = new sqlite3.Database(dbPath, (error) => {
  if (error) {
    console.error('Error opening database:', error.message);
  } else {
    io.on('connection', () => {
      let text = 'Database Connected.';
      io.emit('logging', text);
      console.log(text);
    })
    server.listen(PORT, () => {
      console.log(`Server berjalan di http://localhost:${PORT}`);
    });
  }
});

if (!exists) {
  db.run('CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, status BOOLEAN)');
  db.run('CREATE TABLE autoreply (id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT, message TEXT)');
}

db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'", (error, row) => {
  if (error) {
    console.error(`Error checking table existence: ${error.message}`);
  } else if (!row) {
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, identity VARCHAR(30), code TEXT, phone VARCHAR(30) DEFAULT NULL, qrcode TEXT, status BOOLEAN DEFAULT 0)', (error) => {
      if (error) {
        console.error(`Error creating table: ${error.message}`);
      } else {
        console.log('Table users created successfully.');
        db.run('INSERT INTO users (identity) VALUES ("00001")', (error) => {
          if (error) {
            console.error(`Error insert users: ${error.message}`);
          } else {
            let text = 'Berhasil membuat pengguna.';
            io.emit('logging', text);
            console.log(text);
          }
        });
      }
    });
  } else {
    db.run(`UPDATE users SET status = 0, qrcode = NULL`, (error) => {
      if (error) {
        console.error(`Error updating status: ${error.message}`);
      } else {
        let text = 'Berhasil update pengguna.';
        io.emit('logging', text);
        console.log(text);
      }
    });
  }
});

let numbers = [];
let image;
let pmb;
let identity;
let reqMessage;
let titleMessage;
let nameFile = '';
let typeFile = '';
let stopFlag = false;

client.on('ready', () => {
  console.log("[INFO] Event 'ready' terdeteksi!");

  try {
    const phone = client.info.wid.user;
    console.log(`[INFO] Nomor WhatsApp Client: ${phone}`);

    db.run(`UPDATE users SET phone = '${phone}', status = 1 WHERE identity = '00001'`, (error) => {
      if (error) {
        console.error(`[ERROR] Gagal update user: ${error.message}`);
      } else {
        let info = `Client ${phone} sudah berjalan!`;
        console.log(`[SUCCESS] ${info}`);

        io.emit('ready', true);
        io.emit('logging', info);
      }
    });
  } catch (error) {
    console.error("[ERROR] Terjadi kesalahan pada event 'ready':", error);
    io.emit('logging', error);
  }
});

client.on('changed_state', (data) => {
  console.log("[INFO] Event 'changed_state' terdeteksi!");

  try {
    console.log(`[STATE CHANGED] Data baru:`, data);
    io.emit('logging', data);
  } catch (error) {
    console.error("[ERROR] Terjadi kesalahan pada event 'changed_state':", error);
    io.emit('logging', error);
  }
});

client.on('qr', (qr) => {
  console.log("[INFO] Event 'qr' terdeteksi! QR Code sedang dibuat...");

  try {
    qrcode.toDataURL(qr, (error, url) => {
      if (error) {
        console.error(`[ERROR] Gagal menghasilkan QR Code: ${error.message}`);
        return;
      }

      console.log("[SUCCESS] QR Code berhasil dibuat!");

      db.run(`UPDATE users SET qrcode = "${url}" WHERE identity = '00001'`, (error) => {
        if (error) {
          console.error(`[ERROR] Gagal update QR Code ke database: ${error.message}`);
        } else {
          console.log("[SUCCESS] QR Code berhasil disimpan ke database!");

          io.emit('qrcode', true);
          io.emit('qrcodeval', url);

          let text = 'QR Code tersedia.'
          io.emit('logging', text);
          console.log(`[INFO] ${text}`);
        }
      });
    })
  } catch (error) {
    console.error("[ERROR] Terjadi kesalahan di event 'qr':", error);
    console.log(error);
  }
});

client.on('message', (message) => {
  try {
    let sender = message._data.notifyName || "Unknown";
    let pesan = message.body?.trim() || "";

    if (!pesan) {
      console.log(`[INFO] Pesan kosong diterima dari ${sender}, diabaikan.`);
      return;
    }

    let messageAuto = pesan.replace(/['";]/g, '').toLowerCase();
    console.log(`[INFO] Mencari autoreply untuk: "${messageAuto}"`);

    db.all(`SELECT * FROM autoreply WHERE trigger = ? LIMIT 1`, [messageAuto], (error, rows) => {
      if (error) {
        console.error(`[ERROR] Gagal mengambil autoreply: ${error.message}`);
        return;
      }

      if (rows.length > 0) {
        let replyMessage = rows[0].message;
        console.log(`[SUCCESS] Menjawab dengan: "${replyMessage}"`);
        message.reply(replyMessage);
      } else {
        console.log(`[INFO] Tidak ada autoreply untuk pesan ini.`);
      }
    });
  } catch (error) {
    console.error(`[ERROR] Terjadi kesalahan di event 'message':`, error);
    io.emit('logging', error);
  }
});

client.on('loading_screen', (percent) => {
  try {
    if (typeof percent !== "number" || isNaN(percent)) {
      console.error("[ERROR] Data loading_screen bukan angka:", percent);
      return;
    }
    console.log(`[INFO] Loading progress: ${percent}%`);
    io.emit('loading', percent);

    if (percent === 100) {
      console.log("[SUCCESS] Loading selesai, menyembunyikan QR Code.");
      io.emit('qrcode', false);
    }
  } catch (error) {
    console.error("[ERROR] Terjadi kesalahan di event 'loading_screen':", error);
    io.emit('logging', error);
  }
});

client.on('disconnected', () => {
  try {
    console.log("[INFO] Client terputus. Memperbarui status di database...");

    db.run(`UPDATE users SET status = 0, qrcode = NULL`, (error) => {
      if (error) {
        console.error("[ERROR] Gagal memperbarui status pengguna:", error.message);
      } else {
        let info = 'Status diperbarui untuk semua pengguna.';
        console.log(`[SUCCESS] ${info}`);
        io.emit('logging', info);
      }
    });
    io.emit('signout', true);
    if (client) {
      console.log("[INFO] Menginisialisasi ulang client...");
      client.initialize();
    } else {
      console.error("[ERROR] Client tidak tersedia. Tidak dapat menginisialisasi ulang.");
    }
  } catch (error) {
    console.error("[ERROR] Terjadi kesalahan saat menangani 'disconnected':", error);
    io.emit('logging', error);
  }
});

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'client')));

app.use(express.urlencoded({
  extended: true,
  limit: '25mb'
}));

app.get('/', (req, res) => {
  return res.send('WhatsApp Sender Server Lerian Febriana 🚀');
});

app.post('/iseng', async (req, res) => {
  try {
    await client.sendMessage(phoneNumberFormatter(req.body.target), req.body.message);
    return res.send('Pesan terkirim!');
  } catch (error) {
    console.log(error.message);
    return res.send('Gagal mengirim pesan!');
  }
});

app.post('/send', (req, res) => {
  const statePromise = Promise.resolve(client.getState());
  statePromise.then((value) => {
    if (value === 'CONNECTED') {
      console.log('Client is connected. Starting process...');

      resetVariables();
      extractDataFromRequestBody(req.body);
      processContactList(req.body.upload0);

      console.log('Processed numbers:', numbers);

      startSendingProcess();
      emitInfoMessage();
    } else {
      emitErrorMessage();
    }
  }).catch((error) => {
    console.log('Client is not connected. Sending error message.');
    emitErrorMessage();
    io.emit('logging', error);
  })
});

const resetVariables = () => {
  image = null;
  pmb = '';
  identity = '';
  reqMessage = '';
  titleMessage = '';
  nameFile = '';
  typeFile = '';
  numbers = [];
}

const extractDataFromRequestBody = (body) => {
  pmb = body.pmb;
  identity = body.identity;
  reqMessage = body.message;
  titleMessage = body.titleMessage;
  image = body.upload1;
  if (body.upload1 != null) {
    nameFile += body.namefile;
    typeFile += body.type;
  }
}

const processContactList = (contactList) => {
  contactList.split("\n").forEach((item) => {
    let contact = item.split(",");
    if (contact.length >= 2) {
      let check = contact;
      if (check[1].length >= 10) {
        let contactString = JSON.stringify(Object.assign({}, contact));
        let contactObject = JSON.parse(contactString);
        numbers.push(contactObject);
      } else {
        check[1] = '0000000000';
        let contactString = JSON.stringify(Object.assign({}, contact));
        let contactObject = JSON.parse(contactString);
        numbers.push(contactObject);
      }
    } else if (contact.length == 1 && contact[0].length > 0) {
      let check = contact;
      if (check[0].length > 0) {
        check.push('0000000000');
        let contactString = JSON.stringify(Object.assign({}, check));
        let contactObject = JSON.parse(contactString);
        numbers.push(contactObject);
      }
    } else {
      let check = ['undefined', '0000000000'];
      let contactString = JSON.stringify(Object.assign({}, check));
      let contactObject = JSON.parse(contactString);
      numbers.push(contactObject);
    }
  });
}

const startSendingProcess = () => {
  stopFlag = false;
  startLoop(reqMessage, titleMessage, identity, pmb);
}

const emitInfoMessage = () => {
  const info = {
    status: 3,
    message: `🚀 Pengiriman dimulai!`
  };
  console.log('Emitting info message:', info.message);
  io.emit('info', info);
}

const emitErrorMessage = (error) => {
  const errorMessage = error ? `🚨 ${error.message}` : '🚨 Ada masalah pengiriman.';
  console.error('Error occurred:', errorMessage);
  io.emit('info', {
    status: 1,
    message: errorMessage
  });
};

const checkRegisteredNumber = async function (phone) {
  const isRegistered = await client.isRegisteredUser(phone);
  return isRegistered;
}

const sendProcess = async (i, messageBucket, titleMessage, identity, pmb) => {
  let phone = phoneNumberFormatter(numbers[i]['1']);
  let history = apiHistoryDatabase(numbers[i]['1']);
  const isRegisteredNumber = await checkRegisteredNumber(phone);

  let subject = Object.assign(numbers[i]);
  let source = Object.values(subject);
  let object = {};
  object[`&fullname`] = source[0];
  object[`&firstname`] = source[0].split(" ")[0];
  object[`&whatsapp`] = source[1];

  for (let i = 2; i < source.length; i++) {
    object[`&var${i - 1}`] = source[i];
  }

  let key = Object.keys(object).join('|');
  let message = messageBucket.replace(new RegExp(key, "g"), matched => object[matched]);

  let media;
  if (typeof (image) == 'string') {
    let attachment = await axios.get(image, {
      responseType: 'arraybuffer'
    }).then(response => {
      return response.data.toString('base64');
    });
    media = new MessageMedia(typeFile, attachment, nameFile);
  }

  if (history !== '62000000000') {
    await axios.post(`${API_CHAT}/store`, {
      identity: identity,
      pmb: pmb,
      phone: history,
      title: titleMessage,
      result: message
    }, {
      headers: {
        'lp3i-api-key': '8137cd04674735e5'
      }
    })
      .then((res) => {
        let text = 'Chat terbaru sudah tersimpan.'
        io.emit('logging', text);
        console.log(`[SUCCESS] ${text}`);
      })
      .catch((error) => {
        let text = 'Gagal menyimpan chat.';
        io.emit('logging', text);
        console.error(`[ERROR] ${text} - ${error.message}`);
      })
  }

  if (isRegisteredNumber) {
    if (typeof (image) == 'string') {
      client.sendMessage(phone, media, {
        caption: message
      });
      let text = 'Mengirim media berhasil!';
      io.emit('logging', text);
      io.emit('send', true);
      console.log(`[SUCCESS] ${text}`);
    } else {
      client.sendMessage(phone, message);
      let text = 'Mengirim pesan berhasil!';
      io.emit('logging', text);
      io.emit('send', true);
      console.log(`[SUCCESS] ${text}`);
    }

    const nameDB = numbers[i]['0'];
    const phoneDB = numbers[i]['1'];

    db.run(`INSERT INTO contacts (name, phone, status) VALUES (?, ?, ?)`, [nameDB, phoneDB, 1], (error) => {
      if (error) {
        console.error(`[ERROR] Gagal menambahkan kontak: ${error.message}`);
      } else {
        let message = `📞 Kontak ditambahkan: ${nameDB} - ${phoneDB}`;
        console.log(`[SUCCESS] ${message}`);

        io.emit('info', {
          status: 3,
          message: `✅ ${nameDB} - ${phoneDB}`,
        });

        io.emit('percent', { counter: i + 1, length: numbers.length });
      }
    });
  } else {
    const nameDB = numbers[i]['0'];
    const phoneDB = numbers[i]['1'];

    db.run(`INSERT INTO contacts (name, phone, status) VALUES (?, ?, ?)`, [nameDB, phoneDB, 0], (error) => {
      if (error) {
        console.error(`[ERROR] Gagal menambahkan kontak: ${error.message}`);
      } else {
        let message = `📞 Kontak ditambahkan: ${nameDB} - ${phoneDB}`;
        console.log(`[SUCCESS] ${message}`);

        io.emit('info', {
          status: 3,
          message: `✅ ${nameDB} - ${phoneDB}`,
        });

        io.emit('percent', { counter: i + 1, length: numbers.length });
      }
    });
  }
}

async function startLoop(message, titleMessage, identity, pmb) {
  for (let i = 0; i < numbers.length; i++) {
    if (stopFlag) {
      break;
    }
    await delay(7500);
    sendProcess(i, message, titleMessage, identity, pmb);
  }
  setTimeout(() => {
    let info = {
      status: 3,
      message: '🚀 Pengiriman selesai!'
    }
    console.log(`[SUCCESS] ${info.message}`);
    io.emit('info', info);
  }, 2000);
  stopFlag = true;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

io.on('connection', (socket) => {

  let text = 'Client tersambung!'
  console.log(`[INFO] ${text}`);
  io.emit('api', API_ACCOUNT);
  io.emit('logging', text);

  socket.on('disconnect', () => {
    let text = 'Client terputus!'
    console.log(`[WARNING] ${text}`);
    io.emit('logging', text);
  });

  socket.emit('reset');

  socket.on('getUsers', () => {
    db.all(`SELECT * FROM users LIMIT 1`, (error, rows) => {
      if (error) {
        let errorMsg = `Error get users: ${error.message}`;
        console.error(errorMsg);
        io.emit('logging', errorMsg);
      } else {
        if (rows.length > 0) {
          let data = rows[0];
          io.emit('users', data);
          let successMsg = 'Berhasil mengambil data pengguna.';
          io.emit('logging', successMsg);
          console.log(successMsg);
        } else {
          let emptyMsg = 'Tidak ada data pengguna ditemukan.';
          io.emit('logging', emptyMsg);
          console.warn(emptyMsg);
        }
      }
    });
  });

  socket.on('setIdentity', (data) => {
    db.run(`UPDATE users SET code = '${data}' WHERE identity = '00001'`, (error) => {
      if (error) {
        let errorMsg = `Error update user: ${error.message}`;
        console.error(errorMsg);
        io.emit('logging', errorMsg);
      } else {
        let successMsg = 'Identitas Client sudah terupdate!';
        io.emit('logging', successMsg);
        console.log(successMsg);
      }
    });
    db.all(`SELECT * FROM users LIMIT 1`, (error, rows) => {
      if (error) {
        let errorMsg = `Error get user: ${error.message}`;
        console.error(errorMsg);
        io.emit('logging', errorMsg);
      } else {
        if (rows.length > 0) {
          let data = rows[0];
          io.emit('users', data);
          let successMsg = 'Berhasil mengambil pengguna.';
          io.emit('logging', successMsg);
          console.log(successMsg);
        } else {
          let notFoundMsg = 'Tidak ada data pengguna yang ditemukan.';
          io.emit('logging', notFoundMsg);
          console.log(notFoundMsg);
        }
      }
    });
  });

  socket.on('stop', () => {
    stopFlag = true;
    const stopMsg = 'Pengiriman dihentikan oleh pengguna!';
    console.log(stopMsg);
    io.emit('logging', stopMsg);
  });

  socket.on('delete', () => {
    db.exec(`DELETE FROM contacts`, (error) => {
      if (error) {
        console.error(`Error saat menghapus riwayat: ${error.message}`);
        io.emit('logging', 'Gagal menghapus riwayat.');
      } else {
        const deleteMsg = 'Riwayat kontak berhasil dihapus!';
        console.log(deleteMsg);
        io.emit('logging', deleteMsg);
      }
    });
  });

  socket.on('deleteauto', (data) => {
    db.run(`DELETE FROM autoreply WHERE id = ?`, [data], (error) => {
      if (error) {
        console.error(`Error saat menghapus Auto Reply: ${error.message}`);
        io.emit('logging', 'Gagal menghapus Auto Reply.');
      } else {
        const deleteMsg = `Auto Reply dengan ID ${data} berhasil dihapus!`;
        console.log(deleteMsg);
        io.emit('logging', deleteMsg);
      }
    });
  });

  socket.on('getHistory', () => {
    db.all("SELECT * FROM contacts", (error, rows) => {
      if (error) {
        console.error(`Error mengambil riwayat: ${error.message}`);
        io.emit('logging', 'Gagal mengambil riwayat.');
        return;
      };
      io.emit('histories', rows)
      const successMsg = `Berhasil mengambil ${rows.length} riwayat kontak.`;
      console.log(successMsg);
      io.emit('logging', successMsg);
    });
  });

  socket.on('getBot', () => {
    db.all("SELECT * FROM autoreply", (error, rows) => {
      if (error) {
        console.error(`Error mengambil Auto Reply: ${error.message}`);
        io.emit('logging', 'Gagal mengambil Auto Reply.');
        return;
      }

      io.emit('bots', rows);

      const successMsg = `Berhasil mengambil ${rows.length} Auto Reply.`;
      console.log(successMsg);
      io.emit('logging', successMsg);
    });
  });

  socket.on('savebot', (data) => {
    if (!data.trigger || !data.automessage) {
      let errorMsg = 'Data tidak lengkap! Trigger dan pesan harus diisi.';
      console.error(errorMsg);
      io.emit('logging', errorMsg);
      return;
    }

    let triggerCheck = data.trigger.trim();
    let trigger = triggerCheck.replace(/['";]/g, '').toLowerCase();
    let message = data.automessage.trim();

    db.run(
      `INSERT INTO autoreply (trigger, message) VALUES (?, ?)`,
      [trigger, message],
      (error) => {
        if (error) {
          console.error(`Error insert autoreply: ${error.message}`);
          io.emit('logging', 'Gagal menyimpan Auto Reply.');
        } else {
          let successMsg = `🤖 Auto Reply untuk '${data.trigger}' berhasil ditambahkan!`;
          console.log(successMsg);
          io.emit('info', { status: 3, message: successMsg });
          io.emit('logging', successMsg);
        }
      }
    );
  });

})

client.initialize();

process.on('beforeExit', () => {
  console.log('Server Express.js akan berhenti...');
});

process.on('SIGINT', () => {
  console.log('Server Express.js dimatikan melalui SIGINT...');

  io.emit('reset', true);

  io.close(() => {
    console.log('Socket.io ditutup.');
  });

  setTimeout(() => {
    process.exit(0);
  }, 500);
});
