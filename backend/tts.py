import argparse
import asyncio
import os
import re
import edge_tts
import tempfile
import subprocess
import io
import concurrent.futures
import logging
import sys
import time
from pydub import AudioSegment
from pathlib import Path

# Thiết lập logging
logging.basicConfig(filename='tts.log', level=logging.INFO)
logger = logging.getLogger(__name__)

RE_TIME_PATTERN = re.compile(r'(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})')

def format_timestamp(timestamp):
    return timestamp.replace(":", ",").replace(",", ".")

def timestamp_to_seconds(timestamp):
    h, m, s = timestamp.replace(',', '.').split(':')
    return float(h) * 3600 + float(m) * 60 + float(s)

def parse_srt(file_path):
    try:
        with open(file_path, "r", encoding="utf-8") as file:
            content = file.read().strip()
        blocks = re.split(r'\n\n', content)
        subtitles = []
        for block in blocks:
            lines = block.strip().split("\n")
            if len(lines) >= 2:
                timing = lines[1].split(" --> ")
                start_time = timing[0].strip()
                end_time = timing[1].strip()
                text = " ".join(lines[2:]).strip()
                subtitles.append((start_time, end_time, text))
        logger.info(f"Đã phân tích {len(subtitles)} đoạn phụ đề từ {file_path}")
        if not subtitles:
            raise ValueError("File SRT không chứa phụ đề hợp lệ")
        return subtitles
    except Exception as e:
        logger.error(f"Lỗi khi phân tích SRT: {str(e)}")
        print(f"ERROR: Lỗi khi phân tích SRT: {str(e)}", file=sys.stderr)
        raise

async def generate_tts(text, voice='vi-VN-HoaiMyNeural'):
    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as temp_audio:
        temp_audio_path = temp_audio.name
    
    try:
        tts = edge_tts.Communicate(text, voice, rate="+0%")
        await tts.save(temp_audio_path)
        with open(temp_audio_path, "rb") as f:
            audio_data = io.BytesIO(f.read())
        audio_data.seek(0)
        return audio_data
    except Exception as e:
        logger.error(f"Lỗi khi tạo TTS: {str(e)}")
        print(f"ERROR: Lỗi khi tạo TTS: {str(e)}", file=sys.stderr)
        raise
    finally:
        os.remove(temp_audio_path)

def trim_audio(audio):
    duration = len(audio)
    if duration > 1150:
        trimmed_audio = audio[120:-800]
    else:
        trimmed_audio = audio[150:]
    return trimmed_audio

def calculate_speed_factor(trimmed_audio_length, start_time, end_time):
    srt_duration = timestamp_to_seconds(end_time) - timestamp_to_seconds(start_time)
    speed_factor = trimmed_audio_length / 1000 / srt_duration
    speed_factor = max(0.1, min(speed_factor, 100))
    return speed_factor

def speed_up_audio_sox(input_audio_path, output_audio_path, speed_factor):
    factor = max(0.1, min(speed_factor, 100))
    SOX_PATH = os.path.join(os.path.dirname(__file__), "sox", "sox.exe")
    command = [SOX_PATH, input_audio_path, output_audio_path, "tempo", str(factor)]
    try:
        subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as e:
        logger.error(f"Lỗi khi chạy sox: {e.stderr.decode()}")
        print(f"ERROR: Lỗi khi chạy sox: {e.stderr.decode()}", file=sys.stderr)
        raise

def check_and_retry_missing_files(subtitles, audio_files, voice, output_dir, audio_format="mp3", max_retries=3):
    # Tạo danh sách tên file mong đợi từ subtitles
    expected_files = {format_timestamp(segment[0]) + f".{audio_format}" for segment in subtitles}
    # Tạo danh sách tên file thực tế từ audio_files
    generated_files = {os.path.basename(file) for file in audio_files if file}
    
    # Tìm các file bị thiếu
    missing_files = expected_files - generated_files
    if not missing_files:
        logger.info("Tất cả các file âm thanh đã được tạo đầy đủ.")
        return audio_files

    logger.warning(f"Thiếu {len(missing_files)} file âm thanh: {missing_files}")
    print(f"WARNING: Thiếu {len(missing_files)} file âm thanh: {missing_files}", file=sys.stderr)

    # Thử tạo lại các đoạn bị thiếu
    retry_results = []
    missing_segments = [segment for segment in subtitles if format_timestamp(segment[0]) + f".{audio_format}" in missing_files]
    
    for attempt in range(1, max_retries + 1):
        if not missing_segments:
            break
        logger.info(f"Thử lại lần {attempt}/{max_retries} cho {len(missing_segments)} đoạn bị thiếu")
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(missing_segments), 4)) as executor:
            futures = [executor.submit(process_segment, segment, voice, output_dir, audio_format) for segment in missing_segments]
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                if result:
                    retry_results.append(result)
        
        # Cập nhật danh sách file đã tạo
        audio_files.extend(retry_results)
        generated_files = {os.path.basename(file) for file in audio_files if file}
        missing_files = expected_files - generated_files
        missing_segments = [segment for segment in subtitles if format_timestamp(segment[0]) + f".{audio_format}" in missing_files]
        
        if not missing_files:
            logger.info("Đã tạo lại thành công tất cả các file bị thiếu.")
            break
        else:
            logger.warning(f"Còn thiếu {len(missing_files)} file sau lần thử {attempt}: {missing_files}")
            time.sleep(1)  # Nghỉ 1 giây trước khi thử lại để tránh quá tải

    if missing_files:
        logger.error(f"Vẫn còn thiếu {len(missing_files)} file sau {max_retries} lần thử: {missing_files}")
        print(f"ERROR: Vẫn còn thiếu {len(missing_files)} file sau {max_retries} lần thử: {missing_files}", file=sys.stderr)
    else:
        logger.info("Đã hoàn tất việc tạo lại các file bị thiếu.")

    return audio_files

def process_segment(segment, voice, output_dir, audio_format="mp3"):
    start_time, end_time, text = segment
    output_filename = f"{format_timestamp(start_time)}.{audio_format}"
    output_path = os.path.join(output_dir, output_filename)

    try:
        # Tạo TTS
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        tts_audio = loop.run_until_complete(generate_tts(text, voice))
        loop.close()

        # Cắt audio
        audio = AudioSegment.from_file(tts_audio, format="mp3")
        trimmed_audio = trim_audio(audio)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_trimmed_audio:
            temp_trimmed_audio_path = temp_trimmed_audio.name
            trimmed_audio.export(temp_trimmed_audio_path, format="wav")

        # Điều chỉnh tốc độ
        speed_factor = calculate_speed_factor(len(trimmed_audio), start_time, end_time)
        logger.info(f"{output_filename}  {speed_factor:.4f}x {len(trimmed_audio) / 1000}s, {timestamp_to_seconds(end_time) - timestamp_to_seconds(start_time)}s)")

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_final_audio:
            temp_final_audio_path = temp_final_audio.name
            speed_up_audio_sox(temp_trimmed_audio_path, temp_final_audio_path, speed_factor)

        # Lưu file cuối
        final_audio = AudioSegment.from_file(temp_final_audio_path, format="wav")
        final_audio.export(output_path, format=audio_format)

        os.remove(temp_trimmed_audio_path)
        os.remove(temp_final_audio_path)

        logger.info(f"Đã lưu file âm thanh tại: {output_path}")
        return output_path
    except Exception as e:
        logger.error(f"Lỗi khi xử lý đoạn {start_time} --> {end_time}: {str(e)}")
        print(f"ERROR: Lỗi khi xử lý đoạn {start_time} --> {end_time}: {str(e)}", file=sys.stderr)
        return None

def process_srt_multithread(srt_file, voice='vi-VN-HoaiMyNeural', output_dir="output", audio_format="mp3", max_workers=4):
    subtitles = parse_srt(srt_file)
    
    # Tạo thư mục đầu ra nếu chưa tồn tại
    os.makedirs(output_dir, exist_ok=True)
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(process_segment, segment, voice, output_dir, audio_format) for segment in subtitles]
        results = []
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if result:
                results.append(result)
    
    logger.info(f"Đã xử lý lần đầu xong {len(results)} file âm thanh")
    
    # Kiểm tra và tạo lại các file bị thiếu
    final_results = check_and_retry_missing_files(subtitles, results, voice, output_dir, audio_format)
    
    logger.info(f"Đã xử lý xong {len(final_results)} file âm thanh sau khi kiểm tra")
    return final_results

def main():
    parser = argparse.ArgumentParser(description="Convert SRT file to TTS with speed-up using multithreading.")
    parser.add_argument("--open", type=str, help="Path to the SRT file to process", required=True)
    parser.add_argument("--voice", type=str, default="vi-VN-HoaiMyNeural", help="TTS voice name (e.g., vi-VN-HoaiMyNeural)")
    parser.add_argument("--workers", type=int, default=4, help="Number of threads to use")
    parser.add_argument("--output-dir", type=str, default="output", help="Directory to save output audio files")
    args = parser.parse_args()

    srt_file_path = args.open
    voice = args.voice
    max_workers = args.workers
    output_dir = args.output_dir

    if not os.path.exists(srt_file_path):
        logger.error(f"File không tồn tại: {srt_file_path}")
        print(f"ERROR: File không tồn tại: {srt_file_path}", file=sys.stderr)
        sys.exit(1)

    try:
        start_time = time.time()
        audio_files = process_srt_multithread(srt_file_path, voice, output_dir, audio_format="mp3", max_workers=max_workers)
        end_time = time.time()
        logger.info(f"Hoàn thành xử lý TTS trong {end_time - start_time:.2f} giây, tạo được {len(audio_files)} file trong thư mục {output_dir}")
        print(f"Hoàn thành xử lý TTS, tạo được {len(audio_files)} file trong thư mục {output_dir}", file=sys.stdout)
    except Exception as e:
        logger.error(f"Lỗi chính: {str(e)}")
        print(f"ERROR: Lỗi chính: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding='utf-8')
    main()
