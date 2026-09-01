const mysql = require('mysql2');

const pool = mysql.createPool({
    host: '172.20.16.1',     // ← Your Windows IP from ipconfig
    user: 'root',
    password: '',
    database: 'attendance_system',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool.promise();
