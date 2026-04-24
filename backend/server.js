const express = require('express');
const chokidar = require('chokidar');
const WebSocket = require('ws');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const session = require('express-session');
const AdmZip = require('adm-zip');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const fetch = require('node-fetch').default;
const xml2js = require('xml2js');

const OUTPUT_DIR = path.join(__dirname, '../temp/output');
const TEMP_DIR = path.join(__dirname, '../temp/temp');
const SUBTITLES_DIR = path.join(__dirname, '../temp/subtitles');
const STORAGE_DIR = path.join(__dirname, '../temp/luutru');
const API_FILE_PATH = path.join(__dirname, '../api.txt');
const BACKEND_PATH = path.join(__dirname, '../backend');

const activeClients = new Map(); // { tabId: { ws, processes: [], pendingFiles: Set, totalFiles: number, zipPath: string, retryCount: number } }
const clients = new Map(); // Lưu trữ WebSocket clients
// cả 3 nơi tạo clientData đều thêm isTtsRunning: false

// ===== Hàng đợi xử lý nhiều người dùng =====
const jobQueue = []; // [{ tabId, fn, ws }]
let isProcessingJob = false;

async function enqueueJob(tabId, jobFn, ws) {
  const queuePosition = jobQueue.length + (isProcessingJob ? 1 : 0);
  if (queuePosition > 0 && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'queued',
      position: queuePosition,
      message: `Ban dang o vi tri so ${queuePosition} trong hang doi. Server dang xu ly cho ${queuePosition} nguoi khac. Vui long cho...`
    }));
  }
  return new Promise((resolve, reject) => {
    jobQueue.push({ tabId, fn: jobFn, ws, resolve, reject });
    processNextJob();
  });
}

async function processNextJob() {
  if (isProcessingJob || jobQueue.length === 0) return;
  isProcessingJob = true;
  const job = jobQueue.shift();

  // Cap nhat vi tri hang doi cho nhung nguoi con lai
  jobQueue.forEach((j, idx) => {
    const cws = clients.get(j.tabId);
    if (cws && cws.readyState === WebSocket.OPEN) {
      cws.send(JSON.stringify({
        type: 'queue_position',
        position: idx + 1,
        message: `Vi tri hang doi: ${idx + 1}. Vui long cho...`
      }));
    }
  });

  if (job.ws && job.ws.readyState === WebSocket.OPEN) {
    job.ws.send(JSON.stringify({
      type: 'processing_started',
      message: 'Den luot ban! Dang bat dau xu ly...'
    }));
  }

  try {
    const result = await job.fn();
    job.resolve(result);
  } catch (err) {
    job.reject(err);
  } finally {
    isProcessingJob = false;
    processNextJob();
  }
}


const VOICE_MAP = {
  'af': { 'female': 'af-ZA-AdriNeural', 'male': 'af-ZA-WillemNeural' },
  'am': { 'male': 'am-ET-AmehaNeural', 'female': 'am-ET-MekdesNeural' },
  'ar': {
    'female': 'ar-AE-FatimaNeural',
    'male': 'ar-AE-HamdanNeural',
    'ar-AE': { 'female': 'ar-AE-FatimaNeural', 'male': 'ar-AE-HamdanNeural' },
    'ar-BH': { 'male': 'ar-BH-AliNeural', 'female': 'ar-BH-LailaNeural' },
    'ar-DZ': { 'female': 'ar-DZ-AminaNeural', 'male': 'ar-DZ-IsmaelNeural' },
    'ar-EG': { 'female': 'ar-EG-SalmaNeural' }
  },
  'vi': { 'female': 'vi-VN-HoaiMyNeural', 'male': 'vi-VN-NamMinhNeural' },
  'en': { 'female': 'en-US-AriaNeural', 'male': 'en-US-GuyNeural' },
  'es': { 'female': 'es-ES-ElviraNeural', 'male': 'es-ES-AlvaroNeural' },
  'zh': { 'female': 'zh-CN-XiaoxiaoNeural', 'male': 'zh-CN-YunyangNeural' }, // Tiếng Trung (Phổ thông)
  'fr': { 'female': 'fr-FR-DeniseNeural', 'male': 'fr-FR-HenriNeural' },   // Tiếng Pháp
  'de': { 'female': 'de-DE-KatjaNeural', 'male': 'de-DE-ConradNeural' },   // Tiếng Đức
  'ja': { 'female': 'ja-JP-NanamiNeural', 'male': 'ja-JP-KeitaNeural' },   // Tiếng Nhật
  'ko': { 'female': 'ko-KR-SunHiNeural', 'male': 'ko-KR-InJoonNeural' },   // Tiếng Hàn
  'ru': { 'female': 'ru-RU-SvetlanaNeural', 'male': 'ru-RU-DmitryNeural' }, // Tiếng Nga
  'pt': { 'female': 'pt-BR-FranciscaNeural', 'male': 'pt-BR-AntonioNeural' }, // Tiếng Bồ Đào Nha
  'it': { 'female': 'it-IT-ElsaNeural', 'male': 'it-IT-DiegoNeural' }      // Tiếng Ý
};
function checkApiKeys() {
  if (!fsSync.existsSync(API_FILE_PATH)) {
    console.error(`Không tìm thấy file ${API_FILE_PATH}`);
    return false;
  }
  const apiKeys = fsSync.readFileSync(API_FILE_PATH, 'utf8').split('\n').filter(line => line.trim());
  if (apiKeys.length === 0) {
    console.error(`File ${API_FILE_PATH} trống`);
    return false;
  }
  return true;
}

// Hàm trích xuất videoId từ URL
function extractVideoId(input) {
  const urlPattern = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = input.match(urlPattern);
  return match ? match[1] : input;
}


// ===== GỌI taisrt.py để tải phụ đề YouTube =====
// Đáng tin cậy hơn nhiều so với JS thuần - dùng youtube-transcript-api Python
// Cài: pip install youtube-transcript-api

async function fetchAndSaveTranscript(pythonPath, taisrtScriptPath, youtubeUrl, outputSrtPath, lang, ws, tabId) {
  return new Promise((resolve, reject) => {
    const args = [taisrtScriptPath, youtubeUrl, outputSrtPath, '--lang', lang, '--retry', '3'];
    console.log(`[taisrt] Chạy: ${pythonPath} ${args.join(' ')}`);

    const proc = spawn(pythonPath, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stderr = '';
    let stdout = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      stderr += msg;
      // Gửi progress về client
      if (ws && ws.readyState === 1 /*WebSocket.OPEN*/) {
        const lines = msg.split('\n').filter(l => l.trim() && l.includes('[taisrt]'));
        lines.forEach(line => {
          ws.send(JSON.stringify({ type: 'progress', message: line.replace('[taisrt]', '').trim() }));
        });
      }
      process.stdout.write('[taisrt stderr] ' + msg);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        // Trích xuất lỗi rõ ràng từ stderr
        const errorLine = stderr.split('\n').find(l => l.includes('[ERROR]')) || stderr.slice(-300);
        reject(new Error(`taisrt.py thất bại (exit ${code}): ${errorLine}`));
      } else {
        // taisrt.py in "SUCCESS:<path>" ra stdout khi thành công
        if (stdout.includes('SUCCESS:')) {
          resolve(true);
        } else {
          reject(new Error('taisrt.py kết thúc OK nhưng không có SUCCESS signal'));
        }
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Không thể chạy taisrt.py: ${err.message}`));
    });
  });
}


// Hàm định dạng thời gian
function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);

  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

// Hàm pad số
function pad(num, length = 2) {
  return String(num).padStart(length, '0');
}
// Xóa thư mục
function clearDirectory(dir) {
  try {
    if (fsSync.existsSync(dir)) {
      fsSync.readdirSync(dir).forEach(file => {
        const filePath = path.join(dir, file);
        if (fsSync.lstatSync(filePath).isDirectory()) {
          clearDirectory(filePath);
          fsSync.rmdirSync(filePath);
        } else {
          fsSync.unlinkSync(filePath);
        }
      });
      console.log(`Đã xóa nội dung thư mục: ${dir}`);
    }
  } catch (error) {
    console.error(`Lỗi khi xóa thư mục ${dir}:`, error);
  }
}

function clearAllDirectories() {
  [OUTPUT_DIR, TEMP_DIR, SUBTITLES_DIR, STORAGE_DIR].forEach(dir => {
    clearDirectory(dir);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
      console.log(`Đã tạo lại thư mục: ${dir}`);
    }
  });
  if (!fsSync.existsSync(STORAGE_DIR)) {
    fsSync.mkdirSync(STORAGE_DIR, { recursive: true });
    console.log(`Đã tạo thư mục lưu trữ: ${STORAGE_DIR}`);
  }
}

// Đếm số đoạn trong file SRT
function countSrtSegments(srtPath) {
  try {
    const srtContent = fsSync.readFileSync(srtPath, 'utf8');
    const lines = srtContent.split('\n');
    let segmentCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\d+$/.test(lines[i].trim()) && lines[i + 1] && lines[i + 1].includes('-->')) {
        segmentCount++;
      }
    }
    return segmentCount;
  } catch (error) {
    console.error(`Lỗi khi đếm đoạn trong SRT ${srtPath}:`, error);
    return 0;
  }
}

console.log('Đang xóa các thư mục tạm khi khởi động server...');
clearAllDirectories();

const upload = multer({ dest: TEMP_DIR });

app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

app.use(express.static(path.join(__dirname, '../frontend')));
app.use(express.json());

// Middleware kiểm tra tabId
app.use((req, res, next) => {
  const tabId = req.query.tabId;
  console.log(`Yêu cầu: ${req.method} ${req.url}, tabId: ${tabId || 'không có'}`);
  if (tabId && clients.has(tabId)) {
    req.tabId = tabId;
    res.setHeader('X-Tab-Id', tabId);
  } else {
    req.tabId = uuidv4();
    res.setHeader('X-Tab-Id', req.tabId);
  }
  next();
});

// Route phục vụ file âm thanh
app.get('/audio', (req, res) => {
  const filePath = req.query.file;
  console.log(`Đang phục vụ âm thanh: ${filePath}`);

  if (!filePath || !path.isAbsolute(filePath)) {
    return res.status(400).send('Đường dẫn tệp không hợp lệ');
  }

  if (!fsSync.existsSync(filePath)) {
    console.error(`Không tìm thấy tệp: ${filePath}`);
    return res.status(404).send('Tệp không tồn tại');
  }

  res.sendFile(filePath, err => {
    if (err) {
      console.error(`Lỗi khi phục vụ tệp ${filePath}:`, err);
      res.status(500).send('Lỗi khi phục vụ tệp âm thanh');
    }
  });
});

// Route xử lý upload ZIP
app.post('/upload-zip', upload.single('zipFile'), async (req, res) => {
  const tabId = req.tabId;
  const ws = clients.get(tabId);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(400).send('Không tìm thấy kết nối WebSocket cho tabId này');
  }

  try {
    if (!req.file) {
      throw new Error('Không có file ZIP được tải lên');
    }

    if (activeClients.has(tabId)) {
      ws.send(JSON.stringify({
        type: 'busy',
        message: 'Phien cua ban dang duoc xu ly. Vui long cho.'
      }));
      return res.status(429).send('Phien cua ban dang duoc xu ly.');
    }

    await enqueueJob(tabId, () => handleZipUpload(req, res, tabId), ws);
  } catch (error) {
    console.error('Loi trong endpoint /upload-zip:', error);
    if (!res.headersSent) res.status(500).send(`Loi: ${error.message}`);
  }
});

async function handleZipUpload(req, res, tabId) {
  const ws = clients.get(tabId);
  const clientData = { ws, processes: [], pendingFiles: new Set(), totalFiles: 0, zipPath: null, retryCount: 0 };
  activeClients.set(tabId, clientData);

  const sessionOutputDir = path.join(OUTPUT_DIR, `session-${tabId}`);
  const sessionTempDir = path.join(TEMP_DIR, `session-${tabId}`);
  const sessionStorageDir = path.join(STORAGE_DIR, `session-${tabId}`);

  try {
    [sessionOutputDir, sessionTempDir, sessionStorageDir].forEach(dir => {
      if (!fsSync.existsSync(dir)) {
        fsSync.mkdirSync(dir, { recursive: true });
        console.log(`Đã tạo thư mục phiên: ${dir}`);
      }
    });

    const zipFile = req.file;
    const zipPath = path.join(sessionTempDir, `${Date.now()}-${zipFile.originalname}`);
    await fs.rename(zipFile.path, zipPath);

    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();
    const audioFiles = zipEntries.filter(entry => entry.entryName.match(/\.(mp3|wav)$/i));

    if (audioFiles.length === 0) {
      throw new Error('File ZIP không chứa file âm thanh MP3 hoặc WAV nào');
    }

    zip.extractAllTo(sessionOutputDir, true);
    clientData.totalFiles = audioFiles.length;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'total_segments',
        totalSegments: audioFiles.length
      }));
      console.log(`Đã gửi totalSegments (${audioFiles.length}) cho phiên ${tabId}`);
    }

    await waitForFiles(clientData, tabId);

    if (clientData.retryCount < 5) {
      const outputZip = new AdmZip();
      audioFiles.forEach(entry => {
        const filePath = path.join(sessionOutputDir, entry.entryName);
        outputZip.addLocalFile(filePath);
      });
      const zipOutputPath = path.join(sessionStorageDir, `processed-audio-${tabId}.zip`);
      outputZip.writeZip(zipOutputPath);
      clientData.zipPath = zipOutputPath;

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'zip_ready',
          message: 'File ZIP đã sẵn sàng để tải xuống'
        }));
      }
      res.send('Đã xử lý thành công file ZIP và chuẩn bị file tải xuống');
    } else {
      res.status(500).send('Dừng xử lý do không gửi được file âm thanh');
    }
  } catch (error) {
    console.error('Lỗi trong handleZipUpload:', error);
    res.status(500).send(`Lỗi: ${error.message}`);
  }
}

// Route xử lý upload SRT
app.post('/upload-srt', upload.single('srtFile'), async (req, res) => {
  const tabId = req.tabId;
  const ws = clients.get(tabId);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(400).send('Không tìm thấy kết nối WebSocket cho tabId này');
  }

  if (!checkApiKeys()) {
    const errorMsg = `Vui lòng điền ít nhất một API key vào file ${API_FILE_PATH} để xử lý dịch phụ đề. Sau đó tải lại trang`;
    console.error(errorMsg);
    ws.send(JSON.stringify({
      type: 'error',
      message: errorMsg
    }));
    return res.status(400).send(errorMsg);
  }

  try {
    if (!req.file) {
      throw new Error('Không có file SRT được tải lên');
    }

    if (activeClients.has(tabId)) {
      ws.send(JSON.stringify({
        type: 'busy',
        message: 'Phien cua ban dang duoc xu ly. Vui long cho.'
      }));
      return res.status(429).send('Phien cua ban dang duoc xu ly.');
    }

    await enqueueJob(tabId, () => handleSrtUpload(req, res, tabId), ws);
  } catch (error) {
    console.error('Loi trong endpoint /upload-srt:', error);
    if (!res.headersSent) res.status(500).send(`Loi: ${error.message}`);
  }
});

async function handleSrtUpload(req, res, tabId) {
  const ws = clients.get(tabId);
  const clientData = { ws, processes: [], pendingFiles: new Set(), totalFiles: 0, zipPath: null, retryCount: 0 };
  activeClients.set(tabId, clientData);

  const sessionOutputDir = path.join(OUTPUT_DIR, `session-${tabId}`);
  const sessionTempDir = path.join(TEMP_DIR, `session-${tabId}`);
  const sessionSubtitlesDir = path.join(SUBTITLES_DIR, `session-${tabId}`);
  const sessionStorageDir = path.join(STORAGE_DIR, `session-${tabId}`);

  try {
    [sessionOutputDir, sessionTempDir, sessionSubtitlesDir, sessionStorageDir].forEach(dir => {
      if (!fsSync.existsSync(dir)) {
        fsSync.mkdirSync(dir, { recursive: true });
        console.log(`Đã tạo thư mục phiên: ${dir}`);
      }
    });

    const srtPath = req.file.path;
    const originalName = req.file.originalname;
    const srtDestPath = path.join(sessionSubtitlesDir, `${Date.now()}-${originalName}`);
    const mergedSrtPath = path.join(sessionSubtitlesDir, `${Date.now()}-${originalName.replace('.srt', '_merged.srt')}`);
    const translatedSrtPath = path.join(sessionSubtitlesDir, `${Date.now()}-${originalName.replace('.srt', '_translated.srt')}`);

    const targetLanguage = req.body.targetLanguage || 'vi';
    const voiceGender = req.body.voiceGender || 'female';
    const autoTranslateSrt = req.body.autoTranslateSrt === 'true';
    const contextNote = req.body.contextNote || "";

    let pythonPath = path.join(__dirname, '..', 'python', 'python.exe');
    if (!fsSync.existsSync(pythonPath)) pythonPath = path.join(__dirname, '..', 'python', 'python');
    if (!fsSync.existsSync(pythonPath)) pythonPath = 'python';
    const mergeScriptPath = path.join(__dirname, '../scripts/gopsrt.py');
    const translateScriptPath = path.join(__dirname, '../scripts/dich.py');
    const ttsScriptPath = path.join(__dirname, '../backend/tts.py');

    const voiceName = VOICE_MAP[targetLanguage]?.[voiceGender] || VOICE_MAP['vi']['female'];

    await fs.rename(srtPath, srtDestPath);

    const mergeProcess = spawn(pythonPath, [mergeScriptPath, srtDestPath, mergedSrtPath], { cwd: sessionSubtitlesDir });
    clientData.processes.push(mergeProcess);
    await new Promise((resolve, reject) => {
      mergeProcess.on('close', (code) => {
        if (code !== 0) reject(new Error(`Merge failed with code ${code}`));
        else resolve();
      });
      mergeProcess.on('error', (err) => reject(err));
    });

    try {
      const originalSrtContent = await fs.readFile(srtDestPath, 'utf8');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'original_srt',
          content: originalSrtContent
        }));
        console.log(`Đã gửi phụ đề gốc cho phiên ${tabId}`);
      }
    } catch (error) {
      console.error(`Lỗi khi đọc file phụ đề gốc: ${error.message}`);
    }
    const totalSegments = countSrtSegments(mergedSrtPath);
    clientData.totalFiles = totalSegments;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'total_segments',
        totalSegments: totalSegments
      }));
      console.log(`Đã gửi totalSegments (${totalSegments}) cho phiên ${tabId}`);
    }

    const ttsInputPath = autoTranslateSrt ? translatedSrtPath : mergedSrtPath;

    if (autoTranslateSrt) {
      const translateProcess = spawn(pythonPath, [
        translateScriptPath,
        mergedSrtPath,
        translatedSrtPath,
        '--target-lang', targetLanguage,
        ...(contextNote ? ['--context', contextNote] : [])
      ], { cwd: sessionSubtitlesDir });
      clientData.processes.push(translateProcess);
      await new Promise((resolve, reject) => {
        translateProcess.on('close', (code) => {
          if (code !== 0) reject(new Error(`Translate failed with code ${code}`));
          else resolve();
        });
        translateProcess.on('error', (err) => reject(err));
      });
    }

    // Đọc file phụ đề để gửi về client (dùng file đúng tùy theo chế độ)
    const finalSrtPath = autoTranslateSrt ? translatedSrtPath : mergedSrtPath;
    try {
      const finalSrtContent = await fs.readFile(finalSrtPath, 'utf8');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'translated_srt',
          content: finalSrtContent
        }));
        console.log(`Da gui phu de cho phien ${tabId} (autoTranslate=${autoTranslateSrt})`);
      }
    } catch (err) {
      console.error(`Loi khi doc file SRT ${finalSrtPath}: ${err.message}`);
    }

    clientData.isTtsRunning = true;
    const ttsProcess = spawn(pythonPath, [ttsScriptPath, '--open', ttsInputPath, '--voice', voiceName, '--workers', '6', '--output-dir', sessionOutputDir], { cwd: BACKEND_PATH });
    clientData.processes.push(ttsProcess);
    await new Promise((resolve, reject) => {
      ttsProcess.on('close', (code) => {
        if (code !== 0) reject(new Error(`TTS failed with code ${code}`));
        else resolve();
      });
      ttsProcess.on('error', (err) => reject(err));
    });

    await waitForFiles(clientData, tabId);

    if (clientData.retryCount < 5) {
      const outputZip = new AdmZip();
      const audioFiles = fsSync.readdirSync(sessionOutputDir).filter(file => file.match(/\.(mp3|wav)$/i));
      audioFiles.forEach(file => {
        const filePath = path.join(sessionOutputDir, file);
        outputZip.addLocalFile(filePath);
      });
      const zipOutputPath = path.join(sessionStorageDir, `processed-audio-${tabId}.zip`);
      outputZip.writeZip(zipOutputPath);
      clientData.zipPath = zipOutputPath;

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'zip_ready',
          message: 'File ZIP đã sẵn sàng để tải xuống'
        }));
      }
      res.send('Đã xử lý thành công SRT và chuẩn bị file tải xuống');
    } else {
      res.status(500).send('Dừng xử lý do không gửi được file âm thanh');
    }
  } catch (error) {
    console.error('Lỗi trong handleSrtUpload:', error);
    res.status(500).send(`Lỗi: ${error.message}`);
  }
}

// Route xử lý upload YouTube
app.post('/upload-youtube', async (req, res) => {
  const tabId = req.tabId;
  const { youtubeUrl, targetLanguage = 'vi', voiceGender = 'female', autoSubtitles = true } = req.body;
  const ws = clients.get(tabId);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(400).send('Không tìm thấy kết nối WebSocket cho tabId này');
  }

  if (!checkApiKeys()) {
    const errorMsg = `Vui lòng điền ít nhất một API key vào file ${API_FILE_PATH} để xử lý dịch phụ đề. Sau đó tải lại trang`;
    console.error(errorMsg);
    ws.send(JSON.stringify({
      type: 'error',
      message: errorMsg
    }));
    return res.status(400).send(errorMsg);
  }

  try {
    if (!youtubeUrl) {
      throw new Error('Vui lòng cung cấp URL YouTube');
    }

    if (activeClients.has(tabId)) {
      ws.send(JSON.stringify({
        type: 'busy',
        message: 'Phien cua ban dang duoc xu ly. Vui long cho.'
      }));
      return res.status(429).send('Phien cua ban dang duoc xu ly.');
    }

    await enqueueJob(tabId, () => handleYoutubeUpload(req, res, tabId), ws);
  } catch (error) {
    console.error('Loi trong endpoint /upload-youtube:', error);
    if (!res.headersSent) res.status(500).send(`Loi: ${error.message}`);
  }
});

async function handleYoutubeUpload(req, res, tabId) {
  const { youtubeUrl, targetLanguage = 'vi', voiceGender = 'female', autoSubtitles = true, contextNote = "" } = req.body;
  const ws = clients.get(tabId);
  const clientData = { ws, processes: [], pendingFiles: new Set(), totalFiles: 0, zipPath: null, retryCount: 0 };
  activeClients.set(tabId, clientData);

  const sessionOutputDir = path.join(OUTPUT_DIR, `session-${tabId}`);
  const sessionTempDir = path.join(TEMP_DIR, `session-${tabId}`);
  const sessionSubtitlesDir = path.join(SUBTITLES_DIR, `session-${tabId}`);
  const sessionStorageDir = path.join(STORAGE_DIR, `session-${tabId}`);

  try {
    [sessionOutputDir, sessionTempDir, sessionSubtitlesDir, sessionStorageDir].forEach(dir => {
      if (!fsSync.existsSync(dir)) {
        fsSync.mkdirSync(dir, { recursive: true });
        console.log(`Đã tạo thư mục phiên: ${dir}`);
      }
    });

    const timestamp = Date.now();
    const srtDestPath = path.join(sessionSubtitlesDir, `${timestamp}-youtube.srt`);
    const mergedSrtPath = path.join(sessionSubtitlesDir, `${timestamp}-youtube_merged.srt`);
    const translatedSrtPath = path.join(sessionSubtitlesDir, `${timestamp}-youtube_translated.srt`);

    // Resolve python path - thử nhiều vị trí
    let pythonPath = path.join(__dirname, '..', 'python', 'python.exe');
    if (!fsSync.existsSync(pythonPath)) {
      pythonPath = path.join(__dirname, '..', 'python', 'python');
    }
    if (!fsSync.existsSync(pythonPath)) {
      pythonPath = 'python'; // fallback system python
    }
    const taisrtScriptPath = path.join(__dirname, '../scripts/taisrt.py');
    const mergeScriptPath = path.join(__dirname, '../scripts/gopsrt.py');
    const translateScriptPath = path.join(__dirname, '../scripts/dich.py');
    const ttsScriptPath = path.join(__dirname, '../backend/tts.py');

    const voiceName = VOICE_MAP[targetLanguage]?.[voiceGender] || VOICE_MAP['vi']['female'];

    if (autoSubtitles) {
      // === Dùng taisrt.py (youtube-transcript-api) - đáng tin cậy nhất ===
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'progress', message: 'Đang tải phụ đề từ YouTube...' }));
      }

      await fetchAndSaveTranscript(pythonPath, taisrtScriptPath, youtubeUrl, srtDestPath, 'en', ws, tabId);

      if (!fsSync.existsSync(srtDestPath)) {
        throw new Error('taisrt.py không tạo được file SRT');
      }

      try {
        const originalSrtContent = await fs.readFile(srtDestPath, 'utf8');
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'original_srt',
            content: originalSrtContent
          }));
          console.log(`Đã gửi phụ đề gốc cho phiên ${tabId}`);
        }
      } catch (error) {
        console.error(`Lỗi khi đọc file phụ đề gốc: ${error.message}`);
      }      // Gộp SRT
      const mergeProcess = spawn(pythonPath, [mergeScriptPath, srtDestPath, mergedSrtPath], { cwd: sessionSubtitlesDir });
      clientData.processes.push(mergeProcess);
      await new Promise((resolve, reject) => {
        mergeProcess.on('close', (code) => {
          if (code !== 0) reject(new Error(`Merge failed with code ${code}`));
          else resolve();
        });
        mergeProcess.on('error', (err) => reject(err));
      });

      const totalSegments = countSrtSegments(mergedSrtPath);
      clientData.totalFiles = totalSegments;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'total_segments',
          totalSegments: totalSegments
        }));
        console.log(`Đã gửi totalSegments (${totalSegments}) cho phiên ${tabId}`);
      }

      // Dịch SRT nếu cần
      if (autoSubtitles) {
        const translateProcess = spawn(pythonPath, [
          translateScriptPath,
          mergedSrtPath,
          translatedSrtPath,
          '--target-lang', targetLanguage,
          ...(contextNote ? ['--context', contextNote] : [])
        ], { cwd: sessionSubtitlesDir });
        clientData.processes.push(translateProcess);
        await new Promise((resolve, reject) => {
          translateProcess.on('close', (code) => {
            if (code !== 0) reject(new Error(`Translate failed with code ${code}`));
            else resolve();
          });
          translateProcess.on('error', (err) => reject(err));
        });
      }

      const translatedSrtContent = await fs.readFile(translatedSrtPath, 'utf8');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'translated_srt',
          content: translatedSrtContent
        }));
        console.log(`Đã gửi phụ đề dịch cho phiên ${tabId}`);
      }
      // Chuyển SRT thành âm thanh
      const ttsInputPath = autoSubtitles ? translatedSrtPath : mergedSrtPath;
      const ttsProcess = spawn(pythonPath, [
        ttsScriptPath,
        '--open', ttsInputPath,
        '--voice', voiceName,
        '--workers', '5',
        '--output-dir', sessionOutputDir
      ], { cwd: BACKEND_PATH });
      clientData.processes.push(ttsProcess);
      await new Promise((resolve, reject) => {
        ttsProcess.on('close', (code) => {
          clientData.isTtsRunning = false;
          if (code !== 0) reject(new Error(`TTS failed with code ${code}`));
          else resolve();
        });
        ttsProcess.on('error', (err) => reject(err));
      });
    }

    await waitForFiles(clientData, tabId);

    if (clientData.retryCount < 5) {
      const outputZip = new AdmZip();
      const audioFiles = fsSync.readdirSync(sessionOutputDir).filter(file => file.match(/\.(mp3|wav)$/i));
      audioFiles.forEach(file => {
        const filePath = path.join(sessionOutputDir, file);
        outputZip.addLocalFile(filePath);
      });
      const zipOutputPath = path.join(sessionStorageDir, `processed-audio-${tabId}.zip`);
      outputZip.writeZip(zipOutputPath);
      clientData.zipPath = zipOutputPath;

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'zip_ready',
          message: 'File ZIP đã sẵn sàng để tải xuống'
        }));
      }
      res.send('Đã xử lý thành công YouTube và chuẩn bị file tải xuống');
    } else {
      res.status(500).send('Dừng xử lý do không gửi được file âm thanh');
    }
  } catch (error) {
    console.error('Lỗi trong handleYoutubeUpload:', error);
    res.status(500).send(`Lỗi: ${error.message}`);
  }
}

// Hàm chờ file được gửi qua WebSocket
async function waitForFiles(clientData, tabId) {
  return new Promise((resolve) => {
    const checkFilesSent = setInterval(() => {
      if (clientData.pendingFiles.size === clientData.totalFiles || clientData.retryCount >= 5) {
        clearInterval(checkFilesSent);
        if (clientData.retryCount >= 5) {
          console.log(`Dừng xử lý phiên ${tabId} do gửi file thất bại 5 lần`);
          clientData.processes.forEach(proc => proc.kill('SIGTERM'));
        }
        resolve();
      }
    }, 2000);
  });
}

// Route tải xuống file ZIP
app.get('/download-zip', (req, res) => {
  const tabId = req.query.tabId;
  if (!tabId) {
    return res.status(400).send('Thiếu tabId trong yêu cầu');
  }

  const clientData = activeClients.get(tabId);
  const zipPath = path.join(STORAGE_DIR, `session-${tabId}`, `processed-audio-${tabId}.zip`);

  if (clientData && clientData.zipPath && fsSync.existsSync(clientData.zipPath)) {
    res.download(clientData.zipPath, `processed-audio-${tabId}.zip`, (err) => {
      if (err) {
        console.error(`Lỗi khi gửi file ZIP cho phiên ${tabId}:`, err);
        res.status(500).send('Lỗi khi tải xuống file ZIP');
      } else {
        console.log(`Đã gửi file ZIP cho phiên ${tabId}: ${clientData.zipPath}`);
      }
    });
  } else if (fsSync.existsSync(zipPath)) {
    res.download(zipPath, `processed-audio-${tabId}.zip`, (err) => {
      if (err) {
        console.error(`Lỗi khi gửi file ZIP cho phiên ${tabId}:`, err);
        res.status(500).send('Lỗi khi tải xuống file ZIP');
      } else {
        console.log(`Đã gửi file ZIP từ lưu trữ cho phiên ${tabId}: ${zipPath}`);
      }
    });
  } else {
    return res.status(404).send('File ZIP đã bị xóa khi tắt server trước đó hoặc bạn không có quyền truy cập');
  }
});

// Quản lý kết nối WebSocket
wss.on('connection', (ws, req) => {
  const tabId = uuidv4();
  ws.tabId = tabId;
  clients.set(tabId, ws);
  console.log(`WebSocket kết nối với tabId: ${tabId}`);

  ws.send(JSON.stringify({
    type: 'tab_id',
    tabId: tabId
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'resend_missing' && Array.isArray(data.missingFiles)) {
        const tabId = ws.tabId;
        const clientData = activeClients.get(tabId);
        if (clientData && clientData.ws && clientData.ws.readyState === WebSocket.OPEN) {
          data.missingFiles.forEach(filePath => {
            if (fsSync.existsSync(filePath)) {
              clientData.ws.send(JSON.stringify({
                type: 'new_audio',
                filePath: filePath
              }));
              clientData.pendingFiles.add(filePath);
              console.log(`Gửi lại file âm thanh thiếu cho phiên ${tabId}: ${filePath}`);
            }
          });
        }
      }
      // Thêm đoạn này để xử lý xác nhận từ client
      if (data.type === 'client_received_all') {
        const tabId = ws.tabId;
        const clientData = activeClients.get(tabId);
        if (clientData) {
          const sessionOutputDir = path.join(OUTPUT_DIR, `session-${tabId}`);
          const sessionTempDir = path.join(TEMP_DIR, `session-${tabId}`);
          const sessionSubtitlesDir = path.join(SUBTITLES_DIR, `session-${tabId}`);
          const sessionStorageDir = path.join(STORAGE_DIR, `session-${tabId}`);
          setTimeout(() => {
            clearDirectory(sessionOutputDir);
            clearDirectory(sessionTempDir);
            clearDirectory(sessionSubtitlesDir);
            activeClients.delete(tabId);
            console.log(`Đã xóa tài nguyên của phiên ${tabId} sau khi client xác nhận đã nhận đủ file (delay 5s)`);
          }, 5000);
        }
      }
    } catch (err) {
      console.error('Lỗi khi xử lý message từ client:', err);
    }
  });

  ws.on('close', () => {
    console.log(`Nguoi dung da ngat ket noi: ${tabId}`);
    // Xóa khỏi hàng đợi nếu chưa được xử lý
    const queueIdx = jobQueue.findIndex(j => j.tabId === tabId);
    if (queueIdx !== -1) {
      jobQueue.splice(queueIdx, 1);
      console.log(`Da xoa phien ${tabId} khoi hang doi`);
    }
    const clientData = activeClients.get(tabId);
    if (clientData) {
      // Terminate all running processes for this tab
      clientData.processes.forEach(proc => {
        try {
          if (!proc.killed) {
            proc.kill('SIGTERM');
            console.log(`Đã dừng process cho phiên ${tabId}`);
          }
        } catch (error) {
          console.error(`Lỗi khi dừng process cho phiên ${tabId}:`, error);
        }
      });
      // Clear resources immediately
      const sessionOutputDir = path.join(OUTPUT_DIR, `session-${tabId}`);
      const sessionTempDir = path.join(TEMP_DIR, `session-${tabId}`);
      const sessionSubtitlesDir = path.join(SUBTITLES_DIR, `session-${tabId}`);
      const sessionStorageDir = path.join(STORAGE_DIR, `session-${tabId}`);
      clearDirectory(sessionOutputDir);
      clearDirectory(sessionTempDir);
      clearDirectory(sessionSubtitlesDir);
      clearDirectory(sessionStorageDir);
      console.log(`Đã xóa tài nguyên của phiên ${tabId} ngay lập tức`);
      activeClients.delete(tabId);
    }
    clients.delete(tabId);
  });

  ws.on('error', (error) => {
    console.error(`Lỗi WebSocket cho phiên ${tabId}:`, error);
    const clientData = activeClients.get(tabId);
    if (clientData  && clientData.isTtsRunning) {
      clientData.processes.forEach(proc => {
        try {
          if (!proc.killed) {
            proc.kill('SIGTERM');
            console.log(`Đã dừng process do lỗi WebSocket cho phiên ${tabId}`);
          }
        } catch (error) {
          console.error(`Lỗi khi dừng process cho phiên ${tabId}:`, error);
        }
      });
      const sessionOutputDir = path.join(OUTPUT_DIR, `session-${tabId}`);
      const sessionTempDir = path.join(TEMP_DIR, `session-${tabId}`);
      const sessionSubtitlesDir = path.join(SUBTITLES_DIR, `session-${tabId}`);
      const sessionStorageDir = path.join(STORAGE_DIR, `session-${tabId}`);
      clearDirectory(sessionOutputDir);
      clearDirectory(sessionTempDir);
      clearDirectory(sessionSubtitlesDir);
      clearDirectory(sessionStorageDir);
      console.log(`Đã xóa tài nguyên của phiên ${tabId} do lỗi WebSocket`);
      activeClients.delete(tabId);
    }
    clients.delete(tabId);
  });

  ws.on('pong', () => {
    console.log(`Nhận pong từ phiên ${tabId}`);
  });
});

// Theo dõi file MP3/WAV mới
chokidar.watch(OUTPUT_DIR, { persistent: true }).on('add', filePath => {
  if (filePath.match(/\.(mp3|wav)$/i)) {
    const normalizedPath = path.resolve(filePath);
    const tabId = path.basename(path.dirname(filePath)).replace('session-', '');
    const clientData = activeClients.get(tabId);

    if (clientData && clientData.ws && clientData.ws.readyState === WebSocket.OPEN) {
      clientData.ws.send(JSON.stringify({
        type: 'new_audio',
        filePath: normalizedPath
      }));
      clientData.pendingFiles.add(normalizedPath);
      clientData.retryCount = 0;
      console.log(`Đã gửi file âm thanh cho người dùng ${tabId}: ${normalizedPath} (${clientData.pendingFiles.size}/${clientData.totalFiles})`);
    } else {
      if (clientData) {
        clientData.retryCount++;
        console.log(`Không gửi file ${normalizedPath} vì không có client hoạt động cho phiên ${tabId}. Lần thử: ${clientData.retryCount}`);
        if (clientData.retryCount < 5) {
          setTimeout(() => {
            if (clientData.ws && clientData.ws.readyState === WebSocket.OPEN) {
              clientData.ws.send(JSON.stringify({
                type: 'new_audio',
                filePath: normalizedPath
              }));
              clientData.pendingFiles.add(normalizedPath);
              clientData.retryCount = 0;
              console.log(`Thử lại gửi file âm thanh cho người dùng ${tabId}: ${normalizedPath}`);
            }
          }, 1000);
        }
      } else {
        console.log(`Không tìm thấy clientData cho phiên ${tabId}`);
      }
    }
  }
}).on('error', (error) => {
  console.error('Lỗi trong chokidar:', error);
});

// Giữ kết nối WebSocket sống
setInterval(() => {
  clients.forEach((ws, tabId) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      console.log(`Gửi ping tới phiên ${tabId}`);
    }
  });
}, 30000);

// Xử lý tín hiệu tắt server
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => {
    console.log(`Nhận được ${signal}. Đang dọn dẹp và tắt server...`);
    activeClients.forEach((clientData, tabId) => {
      clientData.processes.forEach(proc => {
        try {
          if (!proc.killed) {
            proc.kill('SIGTERM');
            console.log(`Đã dừng process cho phiên ${tabId}`);
          }
        } catch (error) {
          console.error(`Lỗi khi dừng process cho phiên ${tabId}:`, error);
        }
      });
      if (clientData.ws && clientData.ws.readyState === WebSocket.OPEN) {
        clientData.ws.close();
      }
      const sessionOutputDir = path.join(OUTPUT_DIR, `session-${tabId}`);
      const sessionTempDir = path.join(TEMP_DIR, `session-${tabId}`);
      const sessionSubtitlesDir = path.join(SUBTITLES_DIR, `session-${tabId}`);
      const sessionStorageDir = path.join(STORAGE_DIR, `session-${tabId}`);
      clearDirectory(sessionOutputDir);
      clearDirectory(sessionTempDir);
      clearDirectory(sessionSubtitlesDir);
      clearDirectory(sessionStorageDir);
      activeClients.delete(tabId);
    });
    clients.forEach((ws, tabId) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
    clearAllDirectories();
    clearDirectory(STORAGE_DIR);
    console.log(`Đã xóa toàn bộ tài nguyên, bao gồm thư mục ${STORAGE_DIR}`);
    process.exit(0);
  });
});

server.listen(3030, () => {
  console.log('Server đang chạy trên cổng 3030');
});
