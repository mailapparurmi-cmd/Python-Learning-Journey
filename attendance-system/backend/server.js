const express = require('express');
const cors = require('cors');
const db = require('./db');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const faceapi = require('face-api.js');
const canvas = require('canvas');

faceapi.env.monkeyPatch({ Canvas: canvas.Canvas, Image: canvas.Image, ImageData: canvas.ImageData });

const app = express();
app.use(cors());
app.use(express.json());

// ============ FOLDERS ============
const uploadDir = path.join(__dirname, 'uploads');
const faceDataDir = path.join(__dirname, 'face_data');
const modelsDir = path.join(__dirname, 'models');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(faceDataDir)) fs.mkdirSync(faceDataDir);

// ============ LOAD FACE MODELS ============
let modelsLoaded = false;

async function loadFaceModels() {
    try {
        await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsDir);
        await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsDir);
        await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsDir);
        modelsLoaded = true;
        console.log('✅ Face recognition models loaded successfully!');
    } catch (error) {
        console.error('❌ Error loading face models:', error.message);
    }
}
loadFaceModels();

// ============ PHOTO UPLOAD SETUP ============
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'classroom-' + unique + '.jpg');
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use('/uploads', express.static(uploadDir));

// ============ CREATE ADDITIONAL TABLES ============
const initTables = async () => {
    try {
        await db.query(`CREATE TABLE IF NOT EXISTS Exam (
            exam_id INT PRIMARY KEY AUTO_INCREMENT,
            subject_id INT,
            exam_name VARCHAR(100),
            exam_date DATE,
            max_marks INT,
            FOREIGN KEY (subject_id) REFERENCES Subject(subject_id)
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS ExamMarks (
            mark_id INT PRIMARY KEY AUTO_INCREMENT,
            student_id INT,
            exam_id INT,
            marks_obtained INT,
            FOREIGN KEY (student_id) REFERENCES Student(student_id),
            FOREIGN KEY (exam_id) REFERENCES Exam(exam_id)
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS ClassSchedule (
            schedule_id INT PRIMARY KEY AUTO_INCREMENT,
            subject_id INT,
            day_of_week VARCHAR(20),
            start_time TIME,
            end_time TIME,
            room VARCHAR(50),
            FOREIGN KEY (subject_id) REFERENCES Subject(subject_id)
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS StudentLoginHistory (
            login_id INT PRIMARY KEY AUTO_INCREMENT,
            student_id INT,
            login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ip_address VARCHAR(50),
            FOREIGN KEY (student_id) REFERENCES Student(student_id)
        )`);
        await db.query(`ALTER TABLE Attendance ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500) NULL`);
        await db.query(`ALTER TABLE Attendance ADD COLUMN IF NOT EXISTS present_count INT DEFAULT 0`);
        await db.query(`ALTER TABLE Attendance ADD COLUMN IF NOT EXISTS absent_count INT DEFAULT 0`);
        await db.query(`ALTER TABLE Attendance ADD COLUMN IF NOT EXISTS present_students TEXT NULL`);
        await db.query(`ALTER TABLE Attendance ADD COLUMN IF NOT EXISTS confidence INT DEFAULT 0`);
        await db.query(`CREATE TABLE IF NOT EXISTS StudentFaces (
            face_id INT PRIMARY KEY AUTO_INCREMENT,
            student_id INT,
            face_descriptor TEXT,
            sample_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (student_id) REFERENCES Student(student_id)
        )`);
        
        // Branch table
        await db.query(`CREATE TABLE IF NOT EXISTS Branch (
            branch_id INT PRIMARY KEY AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL,
            code VARCHAR(10) UNIQUE NOT NULL,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Add branch_id to Student table
        await db.query(`ALTER TABLE Student ADD COLUMN IF NOT EXISTS branch_id INT`);
        await db.query(`ALTER TABLE Student ADD FOREIGN KEY (branch_id) REFERENCES Branch(branch_id)`);
        
        // Add branch_id to Subject table
        await db.query(`ALTER TABLE Subject ADD COLUMN IF NOT EXISTS branch_id INT`);
        await db.query(`ALTER TABLE Subject ADD FOREIGN KEY (branch_id) REFERENCES Branch(branch_id)`);
        
        // Insert sample branches
        await db.query(`INSERT INTO Branch (name, code, description) VALUES 
            ('Computer Science & Engineering', 'CSE', 'Computer Science and Engineering'),
            ('Information Science & Engineering', 'ISE', 'Information Science and Engineering'),
            ('Artificial Intelligence & Machine Learning', 'AI&ML', 'Artificial Intelligence and Machine Learning'),
            ('Data Science', 'DS', 'Data Science'),
            ('Electronics & Communication', 'ECE', 'Electronics and Communication Engineering')
            ON DUPLICATE KEY UPDATE name = VALUES(name)`);
        
        console.log('✅ Additional tables ready');
    } catch (error) {
        console.log('Tables may already exist:', error.message);
    }
};
initTables();

// ============ STUDENT APIs ============
app.post('/api/signup', async (req, res) => {
    const { name, email, password, branch_id } = req.body;
    try {
        const [result] = await db.query(
            'INSERT INTO Student (name, email, password_hash, photo_status, branch_id) VALUES (?, ?, ?, "pending", ?)',
            [name, email, password, branch_id || 1]
        );
        res.json({ success: true, student_id: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await db.query(
            'SELECT student_id, name, email, photo_status FROM Student WHERE email = ? AND password_hash = ?',
            [email, password]
        );
        if (rows.length > 0) {
            if (rows[0].photo_status !== 'approved') {
                return res.json({ success: false, message: 'Photo pending admin approval' });
            }
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            await db.query(
                'INSERT INTO StudentLoginHistory (student_id, ip_address) VALUES (?, ?)',
                [rows[0].student_id, ip]
            );
            res.json({ success: true, student: rows[0] });
        } else {
            res.json({ success: false, message: 'Invalid credentials' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/subjects', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM Subject ORDER BY subject_id');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/all-subjects', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT subject_id, name, code FROM Subject ORDER BY name');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/attendance-percentage/:student_id', async (req, res) => {
    const { student_id } = req.params;
    try {
        const [rows] = await db.query(`
            SELECT s.subject_id, s.name as subject_name,
                COUNT(a.attendance_id) as total_classes,
                SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) as present_count,
                ROUND(SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) * 100 / NULLIF(COUNT(a.attendance_id), 0), 2) as percentage
            FROM Subject s
            LEFT JOIN Attendance a ON s.subject_id = a.subject_id AND a.student_id = ?
            GROUP BY s.subject_id
        `, [student_id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ADMIN APIs ============
app.post('/api/admin/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await db.query(
            'SELECT admin_id, name, email FROM Admin WHERE email = ? AND password_hash = ?',
            [email, password]
        );
        if (rows.length > 0) {
            res.json({ success: true, admin: rows[0] });
        } else {
            res.json({ success: false, message: 'Invalid credentials' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/students', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM Student ORDER BY student_id');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/today-attendance', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    try {
        const [rows] = await db.query(`
            SELECT s.name, s.email, sub.name as subject, a.status, a.method, a.created_at
            FROM Attendance a
            JOIN Student s ON a.student_id = s.student_id
            JOIN Subject sub ON a.subject_id = sub.subject_id
            WHERE DATE(a.created_at) = ?
            ORDER BY a.created_at DESC
        `, [today]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/attendance-report', async (req, res) => {
    const { start_date, end_date, subject_id } = req.body;
    try {
        let query = `
            SELECT s.name as student_name, s.email, sub.name as subject_name, DATE(a.created_at) as date, a.status, a.method, a.created_at
            FROM Attendance a
            JOIN Student s ON a.student_id = s.student_id
            JOIN Subject sub ON a.subject_id = sub.subject_id
            WHERE DATE(a.created_at) BETWEEN ? AND ?
        `;
        let params = [start_date, end_date];
        if (subject_id) {
            query += ` AND a.subject_id = ?`;
            params.push(subject_id);
        }
        query += ` ORDER BY a.created_at DESC`;
        const [rows] = await db.query(query, params);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/pending-photos', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT student_id, name, email, photo_url, photo_uploaded_at 
             FROM Student WHERE photo_status = 'pending' ORDER BY photo_uploaded_at DESC`
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/verify-photo', async (req, res) => {
    const { student_id, action } = req.body;
    try {
        const status = action === 'approve' ? 'approved' : 'rejected';
        await db.query('UPDATE Student SET photo_status = ? WHERE student_id = ?', [status, student_id]);
        
        console.log(`📸 Photo ${action}d for student ${student_id}`);
        
        if (action === 'approve') {
            try {
                const [student] = await db.query('SELECT photo_url, name FROM Student WHERE student_id = ?', [student_id]);
                
                if (student[0] && student[0].photo_url) {
                    const photoPath = path.join(uploadDir, path.basename(student[0].photo_url));
                    const studentName = student[0].name || 'Student';
                    
                    if (fs.existsSync(photoPath)) {
                        const img = await canvas.loadImage(photoPath);
                        const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
                        
                        if (detection && detection.descriptor) {
                            // Check if face already exists
                            const [existing] = await db.query('SELECT face_id FROM StudentFaces WHERE student_id = ?', [student_id]);
                            
                            if (existing.length > 0) {
                                await db.query(
                                    'UPDATE StudentFaces SET face_descriptor = ?, sample_date = NOW() WHERE student_id = ?',
                                    [JSON.stringify(Array.from(detection.descriptor)), student_id]
                                );
                                console.log(`✅ Face UPDATED for ${studentName}`);
                            } else {
                                await db.query(
                                    'INSERT INTO StudentFaces (student_id, face_descriptor) VALUES (?, ?)',
                                    [student_id, JSON.stringify(Array.from(detection.descriptor))]
                                );
                                console.log(`✅ Face SAVED for ${studentName}`);
                            }
                        } else {
                            console.log(`⚠️ No face detected in photo for ${studentName}`);
                        }
                    } else {
                        console.log(`❌ Photo file missing for ${studentName}`);
                    }
                }
            } catch (err) { 
                console.error('Face save error:', err.message); 
            }
        }
        res.json({ success: true, message: `Photo ${action}d` });
    } catch (error) {
        console.error('Error in verify-photo:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
app.get('/api/admin/pending-teachers', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT t.teacher_id, t.name, t.email, t.qualification, t.experience, 
                    s.name as subject_name, s.code as subject_code, t.created_at
             FROM Teacher t
             JOIN Subject s ON t.subject_id = s.subject_id
             WHERE t.status = 'pending' OR t.status IS NULL
             ORDER BY t.created_at DESC`
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/verify-teacher', async (req, res) => {
    const { teacher_id, action } = req.body;
    try {
        const status = action === 'approve' ? 'approved' : 'rejected';
        await db.query('UPDATE Teacher SET status = ? WHERE teacher_id = ?', [status, teacher_id]);
        res.json({ success: true, message: `Teacher ${action}d` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ STUDENT PHOTO UPLOAD ============
const studentPhotoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'student-' + unique + '.jpg');
    }
});
const studentUpload = multer({ storage: studentPhotoStorage, limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/upload-photo', studentUpload.single('photo'), async (req, res) => {
    const { student_id } = req.body;
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    try {
        const compressedPath = path.join(uploadDir, 'compressed-' + req.file.filename);
        await sharp(req.file.path).resize(300, 300).jpeg({ quality: 80 }).toFile(compressedPath);
        fs.unlinkSync(req.file.path);
        fs.renameSync(compressedPath, req.file.path);
        const photoUrl = `/uploads/${req.file.filename}`;
        await db.query(
            `UPDATE Student SET photo_url = ?, photo_status = 'pending', photo_uploaded_at = NOW() WHERE student_id = ?`,
            [photoUrl, student_id]
        );
        res.json({ success: true, message: 'Photo uploaded! Pending admin approval.', photoUrl });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/student-photo/:student_id', async (req, res) => {
    const { student_id } = req.params;
    try {
        const [rows] = await db.query('SELECT photo_url, photo_status FROM Student WHERE student_id = ?', [student_id]);
        res.json(rows[0] || { photo_status: 'none' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ SAVE FACE DESCRIPTOR ============
app.post('/api/save-face-descriptor', async (req, res) => {
    const { student_id, faceDescriptor } = req.body;
    try {
        await db.query(
            'INSERT INTO StudentFaces (student_id, face_descriptor) VALUES (?, ?)',
            [student_id, JSON.stringify(faceDescriptor)]
        );
        console.log(`✅ Face descriptor saved for student ${student_id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Error saving face descriptor:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ FACE EXTRACTION API ============
app.get('/api/extract-all-faces', async (req, res) => {
    try {
        // Get all approved students with photos
        const [students] = await db.query(
            'SELECT student_id, name, photo_url FROM Student WHERE photo_status = "approved" AND photo_url IS NOT NULL'
        );
        
        console.log(`📸 Found ${students.length} approved students with photos`);
        
        let successCount = 0;
        let results = [];
        
        for (const student of students) {
            if (!student.photo_url) {
                console.log(`❌ No photo URL for student ${student.student_id}`);
                results.push({ name: student.name || `ID:${student.student_id}`, status: 'no_photo_url' });
                continue;
            }
            
            const photoPath = path.join(uploadDir, path.basename(student.photo_url));
            console.log(`📁 Processing: ${student.name || 'Unknown'} (ID: ${student.student_id}) - ${photoPath}`);
            
            if (fs.existsSync(photoPath)) {
                try {
                    const img = await canvas.loadImage(photoPath);
                    const detection = await faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor();
                    
                    if (detection && detection.descriptor) {
                        // Check if face already exists for this student
                        const [existing] = await db.query(
                            'SELECT face_id FROM StudentFaces WHERE student_id = ?',
                            [student.student_id]
                        );
                        
                        if (existing.length > 0) {
                            await db.query(
                                'UPDATE StudentFaces SET face_descriptor = ?, sample_date = NOW() WHERE student_id = ?',
                                [JSON.stringify(Array.from(detection.descriptor)), student.student_id]
                            );
                            console.log(`✅ Face UPDATED for ${student.name}`);
                        } else {
                            await db.query(
                                'INSERT INTO StudentFaces (student_id, face_descriptor) VALUES (?, ?)',
                                [student.student_id, JSON.stringify(Array.from(detection.descriptor))]
                            );
                            console.log(`✅ Face SAVED for ${student.name}`);
                        }
                        successCount++;
                        results.push({ name: student.name || `Student ${student.student_id}`, status: 'success' });
                    } else {
                        console.log(`❌ No face detected in photo for ${student.name}`);
                        results.push({ name: student.name || `Student ${student.student_id}`, status: 'no_face_detected' });
                    }
                } catch (err) {
                    console.error(`❌ Error processing ${student.name}:`, err.message);
                    results.push({ name: student.name || `Student ${student.student_id}`, status: 'error', error: err.message });
                }
            } else {
                console.log(`❌ Photo file missing for ${student.name}: ${photoPath}`);
                results.push({ name: student.name || `Student ${student.student_id}`, status: 'file_missing' });
            }
        }
        
        res.json({ 
            success: true, 
            message: `Processed ${students.length} students, ${successCount} faces saved/updated`,
            totalStudents: students.length,
            facesSaved: successCount,
            results: results 
        });
        
    } catch (error) {
        console.error('Error in face extraction:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// ============ TEACHER APIs ============
app.post('/api/teacher/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows] = await db.query(
            `SELECT t.teacher_id, t.name, t.email, t.subject_id, s.name as subject_name 
             FROM Teacher t JOIN Subject s ON t.subject_id = s.subject_id 
             WHERE t.email = ? AND t.password_hash = ? AND t.status = 'approved'`,
            [email, password]
        );
        if (rows.length > 0) res.json({ success: true, teacher: rows[0] });
        else res.json({ success: false, message: 'Invalid credentials' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/teacher/signup', async (req, res) => {
    const { name, email, password, subject_name, new_subject, qualification, experience, phone, address } = req.body;
    try {
        const [existing] = await db.query('SELECT * FROM Teacher WHERE email = ?', [email]);
        if (existing.length > 0) return res.json({ success: false, message: 'Email already registered!' });
        
        let subject_id = null;
        if (new_subject && new_subject.trim() !== '') {
            const code = new_subject.substring(0, 3).toUpperCase();
            const [existingSub] = await db.query('SELECT subject_id FROM Subject WHERE name = ?', [new_subject]);
            if (existingSub.length > 0) subject_id = existingSub[0].subject_id;
            else {
                const [result] = await db.query('INSERT INTO Subject (name, code) VALUES (?, ?)', [new_subject, code]);
                subject_id = result.insertId;
            }
        } else if (subject_name && subject_name !== 'new') subject_id = parseInt(subject_name);
        
        if (!subject_id) return res.json({ success: false, message: 'Please select or enter a subject' });
        
        await db.query(
            `INSERT INTO Teacher (name, email, password_hash, subject_id, qualification, experience, phone, address, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [name, email, password, subject_id, qualification, experience || 0, phone, address]
        );
        res.json({ success: true, message: 'Registration successful! Waiting for admin approval.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/teacher/subject/:teacher_id', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT s.subject_id, s.name, s.code FROM Teacher t JOIN Subject s ON t.subject_id = s.subject_id WHERE t.teacher_id = ?`,
            [req.params.teacher_id]
        );
        res.json(rows[0] || null);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/teacher/students/:subject_id', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT s.student_id, s.name, s.email, s.photo_url, s.branch_id, b.name as branch_name
             FROM Student s
             LEFT JOIN Branch b ON s.branch_id = b.branch_id
             WHERE s.photo_status = 'approved'
             ORDER BY s.name`,
            [req.params.subject_id]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ MARK ATTENDANCE ============
app.post('/api/teacher/mark-attendance', async (req, res) => {
    const { teacher_id, student_id, subject_id, status, attendance_date } = req.body;
    const date = attendance_date || new Date().toISOString().split('T')[0];
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    try {
        const [existing] = await db.query(
            'SELECT * FROM Attendance WHERE student_id = ? AND subject_id = ? AND date = ?',
            [student_id, subject_id, date]
        );
        
        if (existing.length > 0) {
            await db.query(
                'UPDATE Attendance SET status = ?, method = ?, created_at = ? WHERE student_id = ? AND subject_id = ? AND date = ?',
                [status, 'teacher', now, student_id, subject_id, date]
            );
            res.json({ success: true, message: `✅ Updated ${status} for ${new Date(date).toLocaleDateString()}` });
        } else {
            await db.query(
                'INSERT INTO Attendance (student_id, subject_id, date, status, method, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [student_id, subject_id, date, status, 'teacher', now]
            );
            res.json({ success: true, message: `✅ Marked ${status} for ${new Date(date).toLocaleDateString()}` });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ GET ATTENDANCE BY DATE ============
app.post('/api/teacher/attendance-by-date', async (req, res) => {
    const { teacher_id, date } = req.body;
    try {
        const [teacher] = await db.query('SELECT subject_id FROM Teacher WHERE teacher_id = ?', [teacher_id]);
        if (teacher.length === 0) return res.json([]);
        
        const [rows] = await db.query(
            `SELECT s.student_id, s.name, s.email, a.status, a.method, a.created_at
             FROM Student s
             LEFT JOIN Attendance a ON s.student_id = a.student_id AND a.subject_id = ? AND a.date = ?
             WHERE s.photo_status = 'approved'`,
            [teacher[0].subject_id, date]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/teacher/today-attendance/:teacher_id', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    try {
        const [teacher] = await db.query('SELECT subject_id FROM Teacher WHERE teacher_id = ?', [req.params.teacher_id]);
        const [rows] = await db.query(
            `SELECT s.student_id, s.name, s.email, a.status, a.method, a.created_at
             FROM Student s
             LEFT JOIN Attendance a ON s.student_id = a.student_id AND a.subject_id = ? AND a.date = ?
             WHERE s.photo_status = 'approved'`,
            [teacher[0].subject_id, today]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ATTENDANCE REPORT ============
app.post('/api/teacher/attendance-report', async (req, res) => {
    const { teacher_id, start_date, end_date } = req.body;
    try {
        const [teacher] = await db.query('SELECT subject_id FROM Teacher WHERE teacher_id = ?', [teacher_id]);
        const [rows] = await db.query(
            `SELECT s.student_id, s.name, s.email, 
                    COUNT(a.attendance_id) as total_classes,
                    SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) as present_count,
                    ROUND(SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) * 100 / NULLIF(COUNT(a.attendance_id), 0), 2) as percentage
             FROM Student s
             LEFT JOIN Attendance a ON s.student_id = a.student_id AND a.subject_id = ? AND a.date BETWEEN ? AND ?
             WHERE s.photo_status = 'approved'
             GROUP BY s.student_id
             ORDER BY percentage DESC`,
            [teacher[0].subject_id, start_date, end_date]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ ATTENDANCE BY DATE RANGE ============
app.post('/api/attendance-by-date', async (req, res) => {
    const { student_id, start_date, end_date } = req.body;
    try {
        const [rows] = await db.query(`
            SELECT a.date, s.name as subject_name, a.status, a.method, a.subject_id
            FROM Attendance a
            JOIN Subject s ON a.subject_id = s.subject_id
            WHERE a.student_id = ? AND a.date BETWEEN ? AND ?
            ORDER BY a.date DESC
        `, [student_id, start_date, end_date]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ EXAM MARKS APIs ============
app.get('/api/exams/:subject_id', async (req, res) => {
    const { subject_id } = req.params;
    try {
        const [rows] = await db.query('SELECT * FROM Exam WHERE subject_id = ? ORDER BY exam_date DESC', [subject_id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/exam-marks/:student_id/:subject_id', async (req, res) => {
    const { student_id, subject_id } = req.params;
    try {
        const [rows] = await db.query(`
            SELECT e.exam_name, e.exam_date, e.max_marks, em.marks_obtained,
                   ROUND((em.marks_obtained / e.max_marks) * 100, 2) as percentage
            FROM Exam e
            LEFT JOIN ExamMarks em ON e.exam_id = em.exam_id AND em.student_id = ?
            WHERE e.subject_id = ?
            ORDER BY e.exam_date DESC
        `, [student_id, subject_id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/add-exam-marks', async (req, res) => {
    const { teacher_id, subject_id, student_id, exam_id, marks_obtained } = req.body;
    try {
        await db.query(
            'INSERT INTO ExamMarks (student_id, exam_id, marks_obtained) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE marks_obtained = ?',
            [student_id, exam_id, marks_obtained, marks_obtained]
        );
        res.json({ success: true, message: 'Marks added successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ CLASS SCHEDULE APIs ============
app.get('/api/class-schedule/:teacher_id', async (req, res) => {
    const { teacher_id } = req.params;
    try {
        const [teacher] = await db.query('SELECT subject_id FROM Teacher WHERE teacher_id = ?', [teacher_id]);
        if (teacher.length === 0) return res.json([]);
        
        const [rows] = await db.query(`
            SELECT cs.*, s.name as subject_name 
            FROM ClassSchedule cs
            JOIN Subject s ON cs.subject_id = s.subject_id
            WHERE cs.subject_id = ?
            ORDER BY FIELD(day_of_week, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), start_time
        `, [teacher[0].subject_id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/add-class-schedule', async (req, res) => {
    const { teacher_id, subject_id, day_of_week, start_time, end_time, room } = req.body;
    try {
        await db.query(
            'INSERT INTO ClassSchedule (subject_id, day_of_week, start_time, end_time, room) VALUES (?, ?, ?, ?, ?)',
            [subject_id, day_of_week, start_time, end_time, room]
        );
        res.json({ success: true, message: 'Schedule added successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ STUDENT LOGIN HISTORY APIs ============
app.get('/api/student-login-history/:teacher_id', async (req, res) => {
    const { teacher_id } = req.params;
    try {
        const [teacher] = await db.query('SELECT subject_id FROM Teacher WHERE teacher_id = ?', [teacher_id]);
        if (teacher.length === 0) return res.json([]);
        
        const [rows] = await db.query(`
            SELECT s.student_id, s.name, s.email, lh.login_time, lh.ip_address
            FROM StudentLoginHistory lh
            JOIN Student s ON lh.student_id = s.student_id
            WHERE s.photo_status = 'approved'
            ORDER BY lh.login_time DESC
            LIMIT 100
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/student-login-summary/:teacher_id', async (req, res) => {
    const { teacher_id } = req.params;
    try {
        const [teacher] = await db.query('SELECT subject_id FROM Teacher WHERE teacher_id = ?', [teacher_id]);
        if (teacher.length === 0) return res.json([]);
        
        const [rows] = await db.query(`
            SELECT s.student_id, s.name, s.email, COUNT(lh.login_id) as total_logins, MAX(lh.login_time) as last_login
            FROM Student s
            LEFT JOIN StudentLoginHistory lh ON s.student_id = lh.student_id
            WHERE s.photo_status = 'approved'
            GROUP BY s.student_id
            ORDER BY total_logins DESC
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ UPLOADED PHOTOS HISTORY API ============
app.post('/api/teacher/photo-history', async (req, res) => {
    const { teacher_id, filter_date, search } = req.body;
    
    try {
        let query = `
            SELECT 
                a.created_at,
                a.photo_url,
                a.present_count,
                a.absent_count,
                a.present_students,
                a.confidence,
                t.name as teacher_name,
                s.name as subject_name
            FROM Attendance a
            JOIN Teacher t ON t.teacher_id = ?
            JOIN Subject s ON s.subject_id = t.subject_id
            WHERE a.method = 'classroom_photo' AND a.photo_url IS NOT NULL
        `;
        
        let params = [teacher_id];
        
        if (filter_date) {
            query += ` AND DATE(a.created_at) = ?`;
            params.push(filter_date);
        }
        
        if (search) {
            query += ` AND a.present_students LIKE ?`;
            params.push(`%${search}%`);
        }
        
        query += ` ORDER BY a.created_at DESC`;
        
        const [rows] = await db.query(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching photo history:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ FACE RECOGNITION CLASSROOM ATTENDANCE ============
app.post('/api/teacher/process-classroom-photo', upload.single('classroomPhoto'), async (req, res) => {
    const { teacher_id, subject_id, attendance_date } = req.body;
    const date = attendance_date || new Date().toISOString().split('T')[0];
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    if (!req.file) return res.status(400).json({ success: false, message: 'No photo uploaded' });
    
    try {
        const [students] = await db.query('SELECT student_id, name FROM Student WHERE photo_status = "approved"');
        if (students.length === 0) {
            fs.unlinkSync(req.file.path);
            return res.json({ success: false, message: 'No approved students found' });
        }
        
        // Get all face descriptors for students
        const studentFaces = [];
        for (const student of students) {
            const [faces] = await db.query(
                'SELECT face_descriptor FROM StudentFaces WHERE student_id = ?',
                [student.student_id]
            );
            for (const face of faces) {
                studentFaces.push({
                    student_id: student.student_id,
                    name: student.name,
                    descriptor: new Float32Array(JSON.parse(face.face_descriptor))
                });
            }
        }
        
        let detectedStudentIds = [];
        let bestOverallConfidence = 0;
        
        if (modelsLoaded && studentFaces.length > 0) {
            try {
                const img = await canvas.loadImage(req.file.path);
                const detections = await faceapi.detectAllFaces(img).withFaceLandmarks().withFaceDescriptors();
                
                for (const detection of detections) {
                    let bestMatch = null;
                    let bestDistance = 0.6;
                    
                    for (const student of studentFaces) {
                        const distance = faceapi.euclideanDistance(detection.descriptor, student.descriptor);
                        if (distance < bestDistance) {
                            bestDistance = distance;
                            bestMatch = student;
                        }
                    }
                    
                    if (bestMatch) {
                        detectedStudentIds.push(bestMatch.student_id);
                        const confidence = Math.round((1 - bestDistance) * 100);
                        if (confidence > bestOverallConfidence) bestOverallConfidence = confidence;
                    }
                }
                detectedStudentIds = [...new Set(detectedStudentIds)];
            } catch (err) {
                console.error('Face detection error:', err);
                detectedStudentIds = students.map(s => s.student_id);
            }
        } else {
            detectedStudentIds = students.map(s => s.student_id);
        }
        
        const isAccepted = bestOverallConfidence >= 50;
        const photoUrl = `/uploads/${req.file.filename}`;
        
        let presentCount = 0, absentCount = 0;
        const presentStudents = [];
        const absentStudents = [];
        
        for (const student of students) {
            const isPresent = detectedStudentIds.includes(student.student_id);
            const status = isPresent ? 'present' : 'absent';
            
            await db.query(
                `INSERT INTO Attendance (student_id, subject_id, date, status, method, created_at, photo_url, present_count, absent_count, present_students, confidence) 
                 VALUES (?, ?, ?, ?, 'face_recognition', ?, ?, ?, ?, ?, ?)`,
                [student.student_id, subject_id, date, status, now, photoUrl, detectedStudentIds.length, students.length - detectedStudentIds.length, 
                 presentStudents.join(', '), bestOverallConfidence]
            );
            
            if (isPresent) {
                presentCount++;
                presentStudents.push(student.name);
            } else {
                absentCount++;
                absentStudents.push(student.name);
            }
        }
        
        res.json({ 
            success: true, 
            message: `${isAccepted ? '✅ ACCEPTED' : '❌ REJECTED'} - ${presentCount} present, ${absentCount} absent (${bestOverallConfidence}% confidence)`,
            photoUrl: photoUrl,
            presentCount: presentCount,
            absentCount: absentCount,
            confidence: bestOverallConfidence,
            accepted: isAccepted
        });
    } catch (error) {
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ BRANCH APIs ============

// Get all branches
app.get('/api/branches', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM Branch ORDER BY name');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get students by branch
app.get('/api/students/by-branch/:branch_id', async (req, res) => {
    const { branch_id } = req.params;
    try {
        const [rows] = await db.query(
            `SELECT s.student_id, s.name, s.email, s.photo_url, s.photo_status,
                    b.name as branch_name
             FROM Student s
             JOIN Branch b ON s.branch_id = b.branch_id
             WHERE s.branch_id = ? AND s.photo_status = 'approved'
             ORDER BY s.name`,
            [branch_id]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get branch statistics
app.get('/api/branch-statistics', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT b.branch_id, b.name, b.code,
                   COUNT(s.student_id) as total_students,
                   SUM(CASE WHEN s.photo_status = 'approved' THEN 1 ELSE 0 END) as approved_students,
                   SUM(CASE WHEN s.photo_status = 'pending' THEN 1 ELSE 0 END) as pending_students
            FROM Branch b
            LEFT JOIN Student s ON b.branch_id = s.branch_id
            GROUP BY b.branch_id
            ORDER BY total_students DESC
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update student branch (Admin)
app.put('/api/student/branch', async (req, res) => {
    const { student_id, branch_id } = req.body;
    try {
        await db.query('UPDATE Student SET branch_id = ? WHERE student_id = ?', [branch_id, student_id]);
        res.json({ success: true, message: 'Branch updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get student's branch info
app.get('/api/student-branch/:student_id', async (req, res) => {
    const { student_id } = req.params;
    try {
        const [rows] = await db.query(
            `SELECT b.branch_id, b.name as branch_name, b.code as branch_code
             FROM Student s
             JOIN Branch b ON s.branch_id = b.branch_id
             WHERE s.student_id = ?`,
            [student_id]
        );
        res.json(rows[0] || {});
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ START SERVER ============
const PORT = 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Uploads folder: ${uploadDir}`);
    console.log(`📁 Face data folder: ${faceDataDir}`);
});