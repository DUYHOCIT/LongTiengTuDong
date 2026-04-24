document.addEventListener('DOMContentLoaded', function () {
    const ip = 'localhost'; // Mặc định là localhost

    // ==== Các phần tử DOM chính ====
    const videoPlayer = document.getElementById('videoPlayer');
    const videoContainer = document.getElementById('videoContainer');
    const videoFile = document.getElementById('videoFile');
    const loadVideo = document.getElementById('loadVideo');
    const videoInfo = document.getElementById('videoInfo');
    const videoDragArea = document.getElementById('videoDragArea');

    const audioFile = document.getElementById('audioFile');
    const loadAudio = document.getElementById('loadAudio');
    const audioInfo = document.getElementById('audioInfo');
    const audioDragArea = document.getElementById('audioDragArea');

    const srtFile = document.getElementById('srtFile');
    const loadSrt = document.getElementById('loadSrt');
    const srtInfo = document.getElementById('srtInfo');
    const srtDragArea = document.getElementById('srtDragArea');

    const playPauseBtn = document.getElementById('playPause');
    const currentTimeDisplay = document.getElementById('currentTime');
    const totalTimeDisplay = document.getElementById('totalTime');
    const audioItems = document.getElementById('audioItems');

    const youtubeUrlInput = document.getElementById('youtubeUrlInput');
    const loadYoutubeVideo = document.getElementById('loadYoutubeVideo');
    const youtubeInfo = document.getElementById('youtubeInfo');

    const sourceTabs = document.querySelectorAll('.video-source-tab');
    const sourceContents = document.querySelectorAll('.video-source-content');

    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');

    const volumeSlider = document.getElementById('volumeSlider');
    const downloadZipBtn = document.getElementById('downloadZip');

    const playbackRateInput = document.getElementById('playbackRate');
    const playbackRateValue = document.getElementById('playbackRateValue');

    const originalSrtMain = document.getElementById('originalSrtMain');
    const translatedSrtMain = document.getElementById('translatedSrtMain');


    // ==== Biến logic ====
    let playbackRate = 1.0;
    let tabId = null;
    let videoDuration = 0;
    let audioElements = []; // Từng { name, audio (Audio object), startTime (seconds) }
    let youtubePlayer = null;
    let isYoutubeActive = false;
    let youtubeUpdateInterval = null;
    let totalSegments = 0;
    let processedSegments = 0;
    let isVideoLoaded = false;
    let isSrtLoaded = false;
    let receivedAudioFiles = new Set();


    autoSubtitles.addEventListener('change', function () {
        const subtitleGroup = loadSrt.closest('.input-group');
        const audioGroup = loadAudio.closest('.input-group');
        const autoTranslateGroup = autoTranslateSrt.closest('.animated-checkbox');

        if (this.checked) {
            subtitleGroup.style.display = 'none';
            audioGroup.style.display = 'none';
            autoTranslateGroup.style.display = 'none';
            srtInfo.textContent = 'Tự động tải phụ đề và dịch được bật';
            audioInfo.textContent = 'Tải âm thanh bị ẩn do tự động xử lý phụ đề';
            disableSrtUpload();
            downloadZipBtn.style.display = 'block';
        } else {
            subtitleGroup.style.display = 'block';
            audioGroup.style.display = 'block';
            autoTranslateGroup.style.display = 'flex';
            srtInfo.textContent = isSrtLoaded ? `File SRT: ${srtFile.files[0]?.name || 'Unknown'} - Đã xử lý` : 'Chưa có file SRT nào được tải lên';
            audioInfo.textContent = audioElements.length > 0 ? `Đã thêm ${audioElements.length} file âm thanh` : 'Chưa có âm thanh nào được tải lên';
            if (isVideoLoaded && !isSrtLoaded) enableSrtUpload();
            downloadZipBtn.style.display = 'none';
        }
    });
    // Tạo AudioContext để điều chỉnh volume chung
    const audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const gainNode = audioContext.createGain();
    gainNode.connect(audioContext.destination);

    const autoTranslateSrt = document.getElementById('autoTranslateSrt');

    autoTranslateSrt.addEventListener('change', function () {
        // Ẩn/hiện phần tải âm thanh khi tích/bỏ tích dịch phụ đề
        const audioGroup = document.getElementById('audioDragArea').closest('.input-group');
        const audioControls = document.getElementById('loadAudio').closest('.input-group');
        // KHÔNG ẩn languageGroup nữa

        if (this.checked) {
            // Chỉ ẩn phần tải âm thanh
            if (audioGroup) audioGroup.style.display = 'none';
            if (audioControls) audioControls.style.display = 'none';
            srtInfo.textContent = 'Dịch phụ đề tự động đang bật, âm thanh đã ẩn';
        } else {
            // Hiện lại khi bỏ check
            if (audioGroup) audioGroup.style.display = 'flex';
            if (audioControls) audioControls.style.display = 'block';
            srtInfo.textContent = isSrtLoaded
                ? `File SRT: ${srtFile.files[0]?.name || 'Unknown'} - Đã xử lý`
                : 'Chưa có file SRT nào được tải lên';
        }
    });
    // Khởi đầu: vô hiệu hóa upload audio cho đến khi video/tải SRT
    disableAudioUpload();

    // ==== Thiết lập WebSocket kết nối server ====
    const ws = new WebSocket(`ws://${ip}:3030`);
    ws.onopen = () => {
        console.log('WebSocket đã kết nối');
        ws.send(JSON.stringify({ type: 'check_status' }));
    };
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Server:', data);

        switch (data.type) {
            case 'error':
                showErrorModal(data.message);
                break;
            case 'tab_id':
                tabId = data.tabId;
                console.log(`Client nhận tabId: ${tabId}`);
                break;
            case 'original_srt':
    if (originalSrtMain) {
        originalSrtMain.textContent = data.content;
        srtInfo.textContent = 'Phụ đề gốc sẵn sàng';
    } else {
        console.error('Không tìm thấy phần tử originalSrtMain');
    }
    break;
case 'translated_srt':
    if (translatedSrtMain) {
        translatedSrtMain.textContent = data.content;
        srtInfo.textContent = 'Phụ đề dịch sẵn sàng';
    } else {
        console.error('Không tìm thấy phần tử translatedSrtMain');
    }
    break;
            case 'status':
                handleServerStatus(data);
                break;
            case 'total_segments':
                totalSegments = data.totalSegments;
                processedSegments = 0;
                updateProgressBar();
                srtInfo.textContent = 'Đang xử lý SRT...';
                youtubeInfo.textContent = 'Đang xử lý YouTube...';
                downloadZipBtn.style.display = 'none';
                setTimeout(checkAndRequestMissingFiles, 10000);
                break;
            case 'new_audio':
                processedSegments++;
                updateProgressBar();
                receivedAudioFiles.add(data.filePath);
                fetchAudioFile(data.filePath);
                if (processedSegments === totalSegments) {
                    ws.send(JSON.stringify({ type: 'client_received_all' }));
                }
                break;
            case 'zip_ready':
                downloadZipBtn.style.display = 'block';
                progressText.textContent = data.message;
                hideErrorModal();
                break;
            case 'wait':
            case 'busy':
                // Dùng chung thông điệp khi busy hoặc wait
                progressText.textContent = data.message;
                progressBar.style.width = '0%';
                srtInfo.textContent = 'Đang chờ server xử lý yêu cầu khác...';
                youtubeInfo.textContent = 'Đang chờ server xử lý yêu cầu khác...';
                showErrorModal('Server đang bận. Vui lòng chờ và tải lại trang.');
                break;
        }
    };

    function handleServerStatus(data) {
        if (data.status === 'wait') {
            // Phiên chờ
            progressText.textContent = 'Đang chờ server xử lý yêu cầu khác...';
            progressBar.style.width = '0%';
            srtInfo.textContent = 'Đang chờ server xử lý yêu cầu khác...';
            youtubeInfo.textContent = 'Đang chờ server xử lý yêu cầu khác...';
            showErrorModal('Server đang bận. Vui lòng chờ và tải lại trang.');
        } else if (data.status === 'busy' && data.tabId !== tabId) {
            // Phiên khác bận
            progressText.textContent = 'Phiên này đang được xử lý ở tab khác...';
            progressBar.style.width = '0%';
            srtInfo.textContent = 'Phiên này đang được xử lý ở tab khác...';
            youtubeInfo.textContent = 'Phiên này đang được xử lý ở tab khác...';
            showErrorModal('Phiên này đang được xử lý ở tab khác. Vui lòng chờ và tải lại trang.');
        } else {
            hideErrorModal();
        }
    }

    function showErrorModal(message) {
        const errorModal = document.getElementById('errorModal');
        const errorMessage = document.getElementById('errorMessage');
        errorMessage.textContent = message;
        errorModal.classList.add('active');
        // Disabled tất cả input/button để tránh tương tác tiếp
        document.querySelectorAll('button, input, select').forEach(ele => ele.disabled = true);
    }

    function hideErrorModal() {
        const errorModal = document.getElementById('errorModal');
        errorModal.classList.remove('active');
        // Bật lại các input/button
        document.querySelectorAll('button, input, select').forEach(ele => ele.disabled = false);
    }

    function checkAndRequestMissingFiles() {
        if (totalSegments > 0 && receivedAudioFiles.size < totalSegments) {
            // Lấy danh sách file trong thư mục output (server không gửi, nên client phải đoán tên file hoặc server phải gửi danh sách)
            // Ở đây ta giả sử tên file là dạng chuẩn, hoặc bạn có thể sửa server gửi danh sách file đúng hơn.
            // Nếu không biết tên file, có thể bỏ qua bước này.
            // Hoặc sau 5-10 giây, nếu thiếu file thì gửi yêu cầu server gửi lại tất cả file chưa nhận.
            const missingFiles = [];
            // Nếu bạn biết danh sách file cần nhận, hãy so sánh và push vào missingFiles
            // Ở đây chỉ gửi lại nếu thiếu số lượng
            ws.send(JSON.stringify({ type: 'resend_missing', missingFiles: Array.from(receivedAudioFiles) }));
        }
    }
    // ==== Lấy audio file từ server (dùng cho SRT hoặc YouTube auto) ====
    async function fetchAudioFile(fullPath) {
        const fileName = fullPath.split(/[\\/]/).pop();
        const audioUrl = `http://${ip}:3030/audio?file=${encodeURIComponent(fullPath)}`;
        try {
            const response = await fetch(audioUrl);
            if (!response.ok) throw new Error('Không thể tải file từ server');
            const blob = await response.blob();
            const audio = new Audio(URL.createObjectURL(blob));
            await new Promise((resolve, reject) => {
                audio.onloadedmetadata = () => resolve();
                audio.onerror = (e) => reject(new Error(`Không thể tải file âm thanh ${fileName}: ${e.message || 'Lỗi không xác định'}`));
            });
            // Lấy thời gian bắt đầu từ tên file (nếu file do server tạo với định dạng HH.MM.SS.mmm_xxx.mp3)
            const startTime = parseTimeFromFilename(fileName) || 0;
            addAudioTrack(fileName, audio, startTime);
        } catch (error) {
            console.error(`Lỗi khi lấy file âm thanh ${fileName}:`, error);
            setTimeout(() => fetchAudioFile(fullPath), 500); // Thử lại sau 500ms
        }
    }

    // ==== Xử lý kéo-thả và click để tải video ====
    videoDragArea.addEventListener('dragover', e => {
        e.preventDefault();
        if (!isVideoLoaded) videoDragArea.classList.add('drag-over');
    });
    videoDragArea.addEventListener('dragleave', () => {
        videoDragArea.classList.remove('drag-over');
    });
    videoDragArea.addEventListener('drop', e => {
        e.preventDefault();
        videoDragArea.classList.remove('drag-over');
        if (isVideoLoaded) {
            videoInfo.textContent = 'Chỉ được tải một video!';
            return;
        }
        const files = e.dataTransfer.files;
        if (files.length !== 1) {
            videoInfo.textContent = 'Chỉ được tải một video!';
            return;
        }
        const file = files[0];
        if (file.type.startsWith('video/')) {
            handleVideoFile(file);
        } else {
            videoInfo.textContent = 'Vui lòng kéo thả file video!';
        }
    });

    loadVideo.addEventListener('click', () => {
        if (!isVideoLoaded) videoFile.click();
    });
    videoFile.addEventListener('change', e => {
        if (e.target.files.length > 0 && !isVideoLoaded) {
            handleVideoFile(e.target.files[0]);
        }
    });

    function handleVideoFile(file) {
        isVideoLoaded = true;
        // Gán nguồn video
        const videoURL = URL.createObjectURL(file);
        videoPlayer.style.display = 'block';
        videoPlayer.src = videoURL;
        videoInfo.textContent = `Video: ${file.name}`;
        disableVideoUpload();
        enableAudioUpload();
        enableSrtUpload();

        // Thiết lập lại tốc độ về 1.0x
        playbackRate = 1.0;
        playbackRateInput.value = playbackRate.toFixed(1);
        playbackRateValue.textContent = playbackRate.toFixed(1) + 'x';
        videoPlayer.playbackRate = playbackRate;

        // Dừng YouTube nếu có
        if (youtubePlayer) {
            youtubePlayer.stopVideo();
            clearInterval(youtubeUpdateInterval);
        }

        // Xóa hết audio cũ
        pauseAllAudio();
        audioElements = [];
        audioItems.innerHTML = '';

        videoPlayer.onloadedmetadata = function () {
            videoDuration = videoPlayer.duration;
            updateTotalTimeDisplay();
        };
    }

    // ==== Xử lý tải YouTube ====
    loadYoutubeVideo.addEventListener('click', () => {
        // Reset tốc độ về 1.0
        playbackRate = 1.0;
        playbackRateInput.value = playbackRate.toFixed(1);
        playbackRateValue.textContent = playbackRate.toFixed(1) + 'x';

        const youtubeUrl = youtubeUrlInput.value.trim();
        const contextNote = document
            .getElementById('contextInputAutoSub')
            .value
            .trim();
        if (!isVideoLoaded && youtubeUrl) {
            const videoId = extractYoutubeId(youtubeUrl);
            if (!videoId) {
                youtubeInfo.textContent = 'URL YouTube không hợp lệ';
                return;
            }
            isVideoLoaded = true;
            youtubeInfo.textContent = 'Đang tải và xử lý video YouTube...';
            processedSegments = 0;
            totalSegments = 0;
            updateProgressBar();
            disableVideoUpload();

            const autoSubtitles = document.getElementById('autoSubtitles').checked;
            if (!autoSubtitles) {
                enableAudioUpload();
                enableSrtUpload();
            } else {
                disableAudioUpload();
                disableSrtUpload();
                fetch(`http://${ip}:3030/upload-youtube?tabId=${tabId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        youtubeUrl,
                        targetLanguage: document.getElementById('targetLanguage').value,
                        voiceGender: document.getElementById('voiceGender').value,
                        autoSubtitles,
                        contextNote
                    }),
                    credentials: 'include'
                })
                    .then(response => {
                        if (response.status === 403) {
                            showErrorModal('Server đang xử lý cho người dùng khác.');
                            return;
                        }
                        if (response.status === 429) {
                            showErrorModal('Phiên của bạn đang được xử lý ở tab khác. Vui lòng chờ và tải lại.');
                            return;
                        }
                        return response.text();
                    })
                    .then(result => {
                        if (result) {
                            youtubeInfo.textContent = `Video YouTube: ${youtubeUrl} - ${result}`;
                        }
                    })
                    .catch(error => {
                        console.error('Lỗi khi xử lý YouTube:', error);
                    });
            }

            if (!youtubePlayer) {
                createYoutubePlayer(videoId);
            } else {
                youtubePlayer.loadVideoById(videoId);
                document.getElementById('youtubePlayer').style.display = 'block';
            }

            pauseAllAudio();
            audioElements = [];
            audioItems.innerHTML = '';

            if (videoPlayer) {
                videoPlayer.pause();
                videoPlayer.currentTime = 0;
            }
            isYoutubeActive = true;
        }
    });

    function extractYoutubeId(url) {
        const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
        const match = url.match(regExp);
        return (match && match[7].length === 11) ? match[7] : null;
    }

    function createYoutubePlayer(videoId) {
        if (document.getElementById('youtubePlayer')) {
            document.getElementById('youtubePlayer').remove();
        }
        const iframe = document.createElement('iframe');
        iframe.id = 'youtubePlayer';
        iframe.width = '100%';
        iframe.height = '500';
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
        iframe.allowFullscreen = true;
        iframe.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1`;
        videoContainer.appendChild(iframe);

        if (window.YT && window.YT.Player) initYoutubePlayer();
        else window.onYouTubeIframeAPIReady = initYoutubePlayer;

        function initYoutubePlayer() {
            youtubePlayer = new YT.Player('youtubePlayer', {
                events: {
                    'onReady': onYoutubePlayerReady,
                    'onStateChange': onYoutubePlayerStateChange
                }
            });
        }
    }

    function onYoutubePlayerReady(event) {
        youtubeInfo.textContent = `Video YouTube: ${youtubePlayer.getVideoData().title}`;
        videoDuration = youtubePlayer.getDuration();
        updateTotalTimeDisplay();
        youtubePlayer.setPlaybackRate(playbackRate);

        youtubeUpdateInterval = setInterval(() => {
            if (youtubePlayer && youtubePlayer.getCurrentTime) {
                const currentTime = youtubePlayer.getCurrentTime();
                updateCurrentTimeDisplay(currentTime);
                if (youtubePlayer.getPlayerState() === YT.PlayerState.PLAYING) {
                    syncAudioWithCurrentTime(currentTime);
                }
            }
        }, 100);
        youtubePlayer.addEventListener('onPlaybackRateChange', function (e) {
            playbackRate = youtubePlayer.getPlaybackRate();
            playbackRateInput.value = playbackRate.toFixed(1);
            playbackRateValue.textContent = playbackRate.toFixed(1) + 'x';
            audioElements.forEach(item => {
                if (item.audio) item.audio.playbackRate = playbackRate;
            });
        });
    }

    function onYoutubePlayerStateChange(event) {
        if (event.data === YT.PlayerState.PLAYING) {
            pauseAllAudio();
            playAudioForTime(youtubePlayer.getCurrentTime());
        } else if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
            pauseAllAudio();
        }
    }

    // ==== Xử lý SRT (giống như audio tách sẵn) ====
    loadSrt.addEventListener('click', () => {
        if (isVideoLoaded && !isSrtLoaded) srtFile.click();
    });
    srtFile.addEventListener('change', e => {
        if (e.target.files.length > 0 && isVideoLoaded && !isSrtLoaded) {
            handleSrtFile(e.target.files[0]);
        }
    });

    function handleSrtFile(file) {
        isSrtLoaded = true;
        srtInfo.textContent = `File SRT: ${file.name} - Đang xử lý...`;
        const formData = new FormData();
        formData.append('srtFile', file);
        formData.append('targetLanguage', document.getElementById('targetLanguage').value);
        formData.append('voiceGender', document.getElementById('voiceGender').value);
        formData.append('autoTranslateSrt', document.getElementById('autoTranslateSrt').checked);
        const contextNote = document.getElementById('contextInputAutoTranslate').value.trim();
        formData.append('contextNote', contextNote);

        fetch(`http://${ip}:3030/upload-srt?tabId=${tabId}`, {
            method: 'POST',
            body: formData,

            credentials: 'include'
        })
            .then(response => {
                if (response.status === 403) {
                    showErrorModal('Server đang xử lý cho người dùng khác.');
                    return;
                }
                if (response.status === 429) {
                    showErrorModal('Phiên này đang được xử lý ở tab khác. Vui lòng chờ.');
                    return;
                }
                return response.text();
            })
            .then(result => {
                if (result) {
                    srtInfo.textContent = `File SRT: ${file.name} - ${result}`;
                    disableSrtUpload();
                }
            })
            .catch(error => {
                console.error('Lỗi:', error);
            });

        pauseAllAudio();
        audioElements = [];
        audioItems.innerHTML = '';
    }

    // ==== Xử lý kéo-thả và click để tải audio riêng ====
    audioDragArea.addEventListener('dragover', e => {
        e.preventDefault();
        audioDragArea.classList.add('drag-over');
    });
    audioDragArea.addEventListener('dragleave', () => {
        audioDragArea.classList.remove('drag-over');
    });
    audioDragArea.addEventListener('drop', e => {
        e.preventDefault();
        audioDragArea.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        let validFiles = 0;
        for (let file of files) {
            if (file.type === 'audio/mpeg' || file.type === 'audio/wav') {
                validFiles++;
                handleAudioFile(file);
            } else if (file.type === 'application/zip' || file.name.endsWith('.zip')) {
                validFiles++;
                handleZipFile(file);
            }
        }
        if (validFiles === 0) {
            audioInfo.textContent = 'Vui lòng kéo thả file MP3, WAV hoặc ZIP!';
        } else {
            audioInfo.textContent = `Đã thêm ${validFiles} file âm thanh`;
        }
    });

    loadAudio.addEventListener('click', () => audioFile.click());
    audioFile.addEventListener('change', e => {
        const files = e.target.files;
        let validFiles = 0;
        for (let file of files) {
            if (file.type === 'audio/mpeg' || file.type === 'audio/wav') {
                validFiles++;
                handleAudioFile(file);
            } else if (file.type === 'application/zip' || file.name.endsWith('.zip')) {
                validFiles++;
                handleZipFile(file);
            }
        }
        if (validFiles === 0) audioInfo.textContent = 'Không có file MP3, WAV hoặc ZIP hợp lệ!';
        else audioInfo.textContent = `Đã chọn ${validFiles} file âm thanh`;
    });

    async function handleAudioFile(file) {
        if (file.type !== 'audio/mpeg' && file.type !== 'audio/wav') {
            audioInfo.textContent = `File không hợp lệ: ${file.name} (Chỉ hỗ trợ MP3 hoặc WAV)`;
            return;
        }
        // Lấy startTime từ tên file nếu có, ngược lại lấy time hiện tại của video/YouTube
        const startTime = parseTimeFromFilename(file.name) ||
            (isYoutubeActive ? (youtubePlayer ? youtubePlayer.getCurrentTime() : 0) : videoPlayer.currentTime);
        try {
            const audioUrl = URL.createObjectURL(file);
            const audio = new Audio(audioUrl);
            await new Promise((resolve, reject) => {
                audio.onloadedmetadata = () => resolve();
                audio.onerror = e => reject(new Error(`Không thể tải file âm thanh ${file.name}: ${e.message || 'Lỗi không xác định'}`));
            });
            audio.volume = gainNode.gain.value;
            addAudioTrack(file.name, audio, startTime);
            audioInfo.textContent = `Âm thanh: ${file.name} - Đã thêm thành công`;
        } catch (error) {
            console.error(`Lỗi khi xử lý file âm thanh ${file.name}:`, error);
            audioInfo.textContent = `Lỗi khi xử lý file âm thanh: ${file.name} - ${error.message}`;
        }
    }

    function handleZipFile(file) {
        audioInfo.textContent = `File ZIP: ${file.name} - Đang xử lý...`;
        const formData = new FormData();
        formData.append('zipFile', file);

        fetch(`http://${ip}:3030/upload-zip?tabId=${tabId}`, {
            method: 'POST',
            body: formData,
            credentials: 'include'
        })
            .then(response => {
                if (response.status === 403) {
                    showErrorModal('Server đang xử lý cho người dùng khác. Vui lòng chờ.');
                    return;
                }
                if (response.status === 429) {
                    showErrorModal('Phiên này đang được xử lý ở tab khác. Vui lòng chờ.');
                    return;
                }
                return response.text();
            })
            .then(result => {
                if (result) {
                    audioInfo.textContent = `File ZIP: ${file.name} - ${result}`;
                }
            })
            .catch(error => {
                console.error('Lỗi khi xử lý ZIP:', error);
                showErrorModal(`Lỗi khi xử lý file ZIP: ${error.message}`);
            });
    }

    // ==== Xử lý nút Play/Pause ====
    playPauseBtn.addEventListener('click', () => {
        if (isYoutubeActive) {
            if (!youtubePlayer) return;
            const state = youtubePlayer.getPlayerState();
            if (state === YT.PlayerState.PLAYING) {
                youtubePlayer.pauseVideo();
                pauseAllAudio();
            } else {
                youtubePlayer.playVideo();
            }
        } else {
            if (videoPlayer.paused) {
                videoPlayer.play();
                playAudioForTime(videoPlayer.currentTime);
            } else {
                videoPlayer.pause();
                pauseAllAudio();
            }
        }
    });
    downloadZipBtn.addEventListener('click', () => {
        window.location.href = `http://${ip}:3030/download-zip?tabId=${tabId}`;
    });
    // ==== Xử lý thay đổi tốc độ (playbackRate) ====
    playbackRateInput.addEventListener('input', function () {
        playbackRate = parseFloat(this.value);
        playbackRateValue.textContent = playbackRate.toFixed(1) + 'x';

        if (isYoutubeActive && youtubePlayer) {
            youtubePlayer.setPlaybackRate(playbackRate);
            // Đồng bộ lại tất cả audio
            audioElements.forEach(item => {
                if (item.audio) item.audio.playbackRate = playbackRate;
            });
        } else if (isVideoLoaded) {
            videoPlayer.playbackRate = playbackRate;
        }

        // Bổ sung: cập nhật playbackRate cho tất cả audioElements
        audioElements.forEach(item => {
            if (item.audio) {
                item.audio.playbackRate = playbackRate;
            }
        });

        // Nếu video/YouTube đang chạy, dừng audio và kích hoạt lại sau 100ms
        if ((isYoutubeActive && youtubePlayer?.getPlayerState() === YT.PlayerState.PLAYING)
            || (!isYoutubeActive && !videoPlayer.paused)) {
            pauseAllAudio();
            setTimeout(() => {
                const currentTime = isYoutubeActive
                    ? youtubePlayer.getCurrentTime()
                    : videoPlayer.currentTime;
                playAudioForTime(currentTime);
            }, 100);
        }
    });



    // ==== Đồng bộ audio theo timeupdate của video HTML5 ====
    videoPlayer.addEventListener('timeupdate', () => {
        if (!isYoutubeActive) {
            updateCurrentTimeDisplay();
            syncAudioWithCurrentTime(videoPlayer.currentTime);
        }
    });
    videoPlayer.addEventListener('pause', pauseAllAudio);
    videoPlayer.addEventListener('play', () => {
        playAudioForTime(videoPlayer.currentTime);
    });
    videoPlayer.addEventListener('seeked', () => {
        pauseAllAudio();
        playAudioForTime(videoPlayer.currentTime);
    });
    videoPlayer.addEventListener('ratechange', () => {
        playbackRate = videoPlayer.playbackRate;
        playbackRateInput.value = playbackRate.toFixed(1);
        playbackRateValue.textContent = playbackRate.toFixed(1) + 'x';
    });

    // ==== Hàm thêm track audio vào mảng và giao diện ====
    function addAudioTrack(name, audio, startTime = 0) {
        if (audioElements.some(item => item.name === name)) {
            console.warn(`Track âm thanh ${name} đã tồn tại`);
            return;
        }
        // Gán audio.playbackRate khớp với playbackRate hiện tại (để duy trì đồng bộ)
        audio.playbackRate = playbackRate;
        // hasStarted: đánh dấu đã bắt đầu phát trong lần chạy hiện tại
        // Tránh restart liên tục khi audio đã ended nhưng currentTime vẫn trong khoảng [start, end]
        const audioItem = { name, audio, startTime, hasStarted: false };
        audioElements.push(audioItem);

        // Hiển thị trong list
        const audioItemElement = document.createElement('div');
        audioItemElement.className = 'audio-item';
        audioItemElement.textContent = `${name} (Bắt đầu: ${formatTime(startTime)})`;
        audioItems.appendChild(audioItemElement);

        // Nếu video/YouTube đang phát và currentTime nằm trong khoảng start...end, phát ngay
        const currentTime = isYoutubeActive
            ? (youtubePlayer ? youtubePlayer.getCurrentTime() : 0)
            : videoPlayer.currentTime;
        if (currentTime >= startTime && currentTime <= startTime + audio.duration) {
            playSingleAudioAtTime(audioItem, currentTime);
        }
    }


    // ==== Hàm format time hiển thị ====
    function formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    }

    // ==== Hàm parse thời gian từ tên file dạng "HH.MM.SS.mmm..." ====
    function parseTimeFromFilename(filename) {
        const timePattern = /^(\d{2})\.(\d{2})\.(\d{2})\.(\d{3})/;
        const match = filename.match(timePattern);
        if (match) {
            const hours = parseInt(match[1], 10);
            const minutes = parseInt(match[2], 10);
            const seconds = parseInt(match[3], 10);
            const milliseconds = parseInt(match[4], 10);
            return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
        }
        return 0;
    }

    // ==== Hàm ngừng và reset tất cả audio ====
    function pauseAllAudio() {
        audioElements.forEach(item => {
            if (item.audio) {
                item.audio.pause();
                item.audio.currentTime = 0;
                // Reset hasStarted để audio có thể phát lại sau khi seek hoặc resume
                item.hasStarted = false;
            }
        });
    }

    // ==== Hàm phát một audio tại thời điểm currentTime ====
    function playSingleAudioAtTime(audioItem, currentTime) {
        if (!audioItem || !audioItem.audio) return;
        const start = audioItem.startTime;
        const end = start + audioItem.audio.duration;
        if (currentTime < start || currentTime > end) return;

        // Không làm gì nếu audio đang phát bình thường (tránh gián đoạn)
        if (!audioItem.audio.paused && !audioItem.audio.ended) return;

        // Cho audio chạy đúng tốc độ hiện tại
        audioItem.audio.playbackRate = playbackRate;

        // Tính offset so với file audio
        const offset = currentTime - start;
        audioItem.audio.currentTime = offset;
        audioItem.audio.volume = gainNode.gain.value;
        audioItem.hasStarted = true;
        audioItem.audio.play().catch(err => {
            console.error(`Lỗi phát ${audioItem.name}:`, err);
            audioItem.hasStarted = false;
        });
    }


    // ==== Đồng bộ tất cả audio theo currentTime ====
    function syncAudioWithCurrentTime(currentTime) {
        audioElements.forEach(item => {
            const start = item.startTime;
            const end = start + item.audio.duration;

            if (currentTime >= start && currentTime <= end) {
                // Chỉ bắt đầu phát nếu:
                // 1. Chưa bắt đầu lần nào (hasStarted = false)
                // 2. Đang bị pause nhưng chưa ended (ví dụ: sau khi resume từ pause)
                // KHÔNG restart nếu audio đã ended tự nhiên (tránh loop loạn)
                if (!item.hasStarted && item.audio.paused && !item.audio.ended) {
                    playSingleAudioAtTime(item, currentTime);
                }
            } else {
                // Ra ngoài khoảng: dừng nếu đang phát
                if (!item.audio.paused) {
                    item.audio.pause();
                    item.audio.currentTime = 0;
                }
                // Reset hasStarted khi currentTime lùi về trước start (user tua lại)
                if (currentTime < start) {
                    item.hasStarted = false;
                }
            }
        });
    }



    // ==== Khi video/YouTube bắt đầu chạy hoặc sau khi tua/pause/play: gọi hàm này để phát audio đúng ====
    function playAudioForTime(currentTime) {
        syncAudioWithCurrentTime(currentTime);
    }

    // ==== Cập nhật hiển thị thời gian hiện tại / tổng thời gian ====
    function updateCurrentTimeDisplay(currentTime) {
        const t = typeof currentTime === 'number' ? currentTime :
            (isYoutubeActive && youtubePlayer ? youtubePlayer.getCurrentTime() : videoPlayer.currentTime);
        currentTimeDisplay.textContent = formatTime(t);
    }
    function updateTotalTimeDisplay() {
        totalTimeDisplay.textContent = formatTime(videoDuration);
    }

    // ==== Cập nhật progress bar khi server xử lý SRT/YouTube ====
    function updateProgressBar() {
        const percentage = totalSegments > 0 ? (processedSegments / totalSegments) * 100 : 0;
        progressBar.style.width = `${percentage}%`;
        progressText.textContent = totalSegments > 0
            ? `Đã xử lý ${processedSegments}/${totalSegments} đoạn (${Math.round(percentage)}%)`
            : 'Đang chờ xử lý...';
        //if (percentage === 100) { // Sửa ở đây
        // khi đã đầy 100%, bật nút tải ZIP tạm (dù file ZIP có thể chưa sẵn sàng)
        //downloadZipBtn.style.display = 'block';
        //}
    }

    // ==== Vô hiệu/hết hiệu hóa upload video, audio, SRT ====
    function disableVideoUpload() {
        loadVideo.disabled = true;
        loadYoutubeVideo.disabled = true;
        videoDragArea.classList.add('disabled');
        sourceTabs.forEach(tab => tab.classList.add('disabled'));
    }
    function enableAudioUpload() {
        loadAudio.disabled = false;
        audioDragArea.classList.remove('disabled');
        audioDragArea.querySelector('p').textContent = 'Kéo và thả file âm thanh (MP3, WAV, ZIP) hoặc nhấn nút';
        audioInfo.textContent = 'Chưa có âm thanh nào được tải lên';
    }
    function disableAudioUpload() {
        loadAudio.disabled = true;
        audioDragArea.classList.add('disabled');
        audioDragArea.querySelector('p').textContent = 'Vui lòng tải video trước để kéo thả file âm thanh';
        audioInfo.textContent = 'Chưa có video, không thể tải âm thanh';
    }
    function enableSrtUpload() {
        loadSrt.style.display = 'block';
        loadSrt.disabled = false;
        srtDragArea.style.display = 'block';
        srtDragArea.classList.remove('disabled');
        srtDragArea.querySelector('p').textContent = 'Kéo và thả file SRT hoặc nhấn nút';
    }
    function disableSrtUpload() {
        loadSrt.style.display = 'none';
        srtDragArea.style.display = 'none';
        srtInfo.textContent = 'Đã tải hoặc tự động xử lý SRT';
    }
    sourceTabs.forEach(tab => {
        tab.addEventListener('click', function () {
            sourceTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            sourceContents.forEach(content => content.classList.remove('active'));
            document.getElementById(tab.dataset.tab + 'VideoContent').classList.add('active');
            isYoutubeActive = tab.dataset.tab === 'youtube';

            // Hiển thị đúng player
            if (isYoutubeActive) {
                if (youtubePlayer) document.getElementById('youtubePlayer').style.display = 'block';
                videoPlayer.style.display = 'none';
            } else {
                videoPlayer.style.display = 'block';
                const yt = document.getElementById('youtubePlayer');
                if (yt) yt.style.display = 'none';
            }

            // Đồng bộ playbackRate
            if (isYoutubeActive && youtubePlayer) {
                youtubePlayer.setPlaybackRate(playbackRate);
            } else if (isVideoLoaded) {
                videoPlayer.playbackRate = playbackRate;
            }
        });
    });

    volumeSlider.addEventListener('input', function () {
        const volume = volumeSlider.value / 100;
        gainNode.gain.value = volume;
        audioElements.forEach(item => {
            if (item.audio) item.audio.volume = volume;
        });
    });
    // ==== Cập nhật hiển thị liên tục (dùng requestAnimationFrame cho YouTube) ====
    function updateTimeline() {
        if (isYoutubeActive && youtubePlayer && youtubePlayer.getCurrentTime) {
            updateCurrentTimeDisplay(youtubePlayer.getCurrentTime());
        }
        requestAnimationFrame(updateTimeline);
    }
    updateTimeline();

    srtDragArea.addEventListener('dragover', e => {
        e.preventDefault();
        srtDragArea.classList.add('drag-over');
    });
    srtDragArea.addEventListener('dragleave', () => {
        srtDragArea.classList.remove('drag-over');
    });
    srtDragArea.addEventListener('drop', e => {
        e.preventDefault();
        srtDragArea.classList.remove('drag-over');
        if (!isVideoLoaded || isSrtLoaded) {
            srtInfo.textContent = 'Vui lòng tải video trước hoặc đã có SRT!';
            return;
        }
        const files = e.dataTransfer.files;
        if (files.length !== 1 || !files[0].name.endsWith('.srt')) {
            srtInfo.textContent = 'Vui lòng kéo thả đúng 1 file SRT!';
            return;
        }
        handleSrtFile(files[0]);
    });
    autoSubtitles.addEventListener('change', function () {
        // ... phần cũ giữ nguyên ...
        document.getElementById('contextInputGroupAutoSub').style.display = this.checked ? 'block' : 'none';
    });

    autoTranslateSrt.addEventListener('change', function () {
        // ... phần cũ giữ nguyên ...
        document.getElementById('contextInputGroupAutoTranslate').style.display = this.checked ? 'block' : 'none';
    });


});
