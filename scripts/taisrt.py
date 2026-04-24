#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
taisrt.py - Tải phụ đề YouTube và lưu thành file SRT
Sử dụng yt-dlp 

Cài đặt: pip install yt-dlp[default]
Dùng:    python taisrt.py <video_id_or_url> <output_srt_path> [--lang en] [--retry 3]
"""

import sys
import re
import os
import argparse
import html
import time

def extract_video_id(input_str):
    """Trích xuất video ID từ URL YouTube hoặc trả về ID trực tiếp."""
    patterns = [
        r'(?:v=|youtu\.be/|embed/|shorts/)([a-zA-Z0-9_-]{11})',
        r'^([a-zA-Z0-9_-]{11})$'
    ]
    for pattern in patterns:
        match = re.search(pattern, input_str)
        if match:
            return match.group(1)
    return None

def format_time_srt(seconds):
    """Chuyển giây sang định dạng SRT: HH:MM:SS,mmm"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds % 1) * 1000))
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

def save_as_srt(transcript_list, output_path):
    """Lưu danh sách transcript thành file SRT."""
    lines = []
    for i, entry in enumerate(transcript_list, 1):
        start = entry.get('start', 0)
        duration = entry.get('duration', 2.0)
        text = html.unescape(entry.get('text', '')).strip()
        text = re.sub(r'\n+', ' ', text)  # Gộp newline thành space
        if not text:
            continue
        end = start + duration
        lines.append(f"{i}")
        lines.append(f"{format_time_srt(start)} --> {format_time_srt(end)}")
        lines.append(text)
        lines.append("")
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    return len([l for l in lines if l.isdigit() or (l and '-->' not in l and l != '')])

def fetch_with_yt_dlp(video_id, preferred_langs):
    """
    Dùng yt-dlp với --impersonate để vượt qua cơ chế chặn tự động.
    Yêu cầu: pip install yt-dlp[default]
    """
    import subprocess
    import tempfile
    import glob
    import shutil
    
    url = f"https://www.youtube.com/watch?v={video_id}"
    
    # Tìm yt-dlp executable
    script_dir = os.path.dirname(os.path.abspath(__file__))
    python_dir = os.path.join(script_dir, '..', 'python')
    
    candidates = [
        os.path.join(python_dir, 'Scripts', 'yt-dlp.exe'),
        os.path.join(python_dir, 'Scripts', 'yt-dlp'),
        'yt-dlp',
    ]
    
    ytdlp_exe = None
    for c in candidates:
        try:
            result = subprocess.run([c, '--version'], capture_output=True, timeout=5)
            if result.returncode == 0:
                ytdlp_exe = c
                break
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
    
    if not ytdlp_exe:
        # Thử python -m yt_dlp
        py_exe = sys.executable
        result = subprocess.run([py_exe, '-m', 'yt_dlp', '--version'], capture_output=True, timeout=5)
        if result.returncode == 0:
            ytdlp_exe = None  # Flag để dùng python -m yt_dlp
        else:
            raise Exception("Chưa cài đặt yt-dlp. Hãy chạy lệnh: pip install yt-dlp[default]")
    
    # Lang string cho yt-dlp
    lang_str = ','.join(preferred_langs + ['en'])
    
    tmp_dir = tempfile.mkdtemp()
    output_template = os.path.join(tmp_dir, '%(id)s.%(ext)s')
    
    base_args = [
        '--write-auto-sub', '--write-sub',
        '--sub-lang', lang_str,
        '--sub-format', 'vtt/ttml/srv1',
        '--skip-download',
        '--no-playlist',
        '--impersonate', 'chrome',  # Vượt qua kiểm tra bot
        '-o', output_template,
        url
    ]
    
    if ytdlp_exe:
        cmd = [ytdlp_exe] + base_args
    else:
        cmd = [sys.executable, '-m', 'yt_dlp'] + base_args
    
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    
    if result.returncode != 0:
        # Thử lại không có --impersonate nếu không hỗ trợ
        base_args_no_imp = [a for a in base_args if a != '--impersonate' and a != 'chrome']
        if ytdlp_exe:
            cmd2 = [ytdlp_exe] + base_args_no_imp
        else:
            cmd2 = [sys.executable, '-m', 'yt_dlp'] + base_args_no_imp
        result2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=120)
        if result2.returncode != 0:
            raise Exception(f"Lỗi yt-dlp: {result2.stderr[-300:]}")
    
    # Tìm file phụ đề vừa tải
    sub_files = glob.glob(os.path.join(tmp_dir, f'{video_id}.*'))
    if not sub_files:
        sub_files = glob.glob(os.path.join(tmp_dir, '*.*'))
    
    sub_file = None
    for ext in ['.vtt', '.ttml', '.srv1', '.xml']:
        matches = [f for f in sub_files if f.endswith(ext)]
        if matches:
            sub_file = matches[0]
            break
    
    if not sub_file:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise Exception("yt-dlp không thể tạo được file phụ đề")
    
    with open(sub_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    shutil.rmtree(tmp_dir, ignore_errors=True)
    
    # Parse VTT hoặc TTML thành list
    ext = os.path.splitext(sub_file)[1].lower()
    if ext == '.vtt':
        return parse_vtt_to_list(content)
    else:
        return parse_ttml_to_list(content)

def parse_vtt_to_list(vtt_content):
    """Parse nội dung VTT thành list các dict {start, duration, text}."""
    entries = []
    lines = vtt_content.split('\n')
    i = 0
    time_pattern = re.compile(r'(\d+):(\d+):(\d+)\.(\d+)\s+-->\s+(\d+):(\d+):(\d+)\.(\d+)')
    
    while i < len(lines):
        m = time_pattern.match(lines[i].strip())
        if m:
            start = int(m[1])*3600 + int(m[2])*60 + int(m[3]) + int(m[4])/1000
            end = int(m[5])*3600 + int(m[6])*60 + int(m[7]) + int(m[8])/1000
            i += 1
            text_lines = []
            while i < len(lines) and lines[i].strip() and not time_pattern.match(lines[i].strip()):
                clean = re.sub(r'<[^>]+>', '', lines[i]).strip()
                if clean and not clean.startswith('NOTE') and '-->' not in clean:
                    text_lines.append(clean)
                i += 1
            if text_lines:
                entries.append({'start': start, 'duration': end - start, 'text': ' '.join(text_lines)})
        else:
            i += 1
    return entries

def parse_ttml_to_list(ttml_content):
    """Parse nội dung TTML thành list các dict {start, duration, text}."""
    entries = []
    def time_to_sec(t):
        if not t: return 0
        m = re.match(r'(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?', t)
        if m:
            return int(m[1] or 0)*3600 + int(m[2])*60 + int(m[3]) + int((m[4] or '0').ljust(3,'0')[:3])/1000
        return float(t.rstrip('s')) if t.endswith('s') else 0
    
    for m in re.finditer(r'<p\s+begin="([^"]+)"\s+end="([^"]+)"[^>]*>(.*?)</p>', ttml_content, re.DOTALL):
        start = time_to_sec(m[1])
        end = time_to_sec(m[2])
        text = re.sub(r'<[^>]+>', '', m[3]).strip()
        text = re.sub(r'\s+', ' ', text)
        if text:
            entries.append({'start': start, 'duration': end - start, 'text': text})
    return entries

def main():
    parser = argparse.ArgumentParser(description='Tải phụ đề YouTube → SRT bằng yt-dlp')
    parser.add_argument('video', help='YouTube URL hoặc Video ID')
    parser.add_argument('output', help='Đường dẫn file SRT đầu ra')
    parser.add_argument('--lang', default='en', help='Ngôn ngữ ưu tiên (vd: en, vi). Mặc định: en')
    # Thêm lại tham số --retry để tương thích với Node.js server
    parser.add_argument('--retry', type=int, default=3, help='Số lần retry khi lỗi')
    args = parser.parse_args()

    video_id = extract_video_id(args.video)
    if not video_id:
        print(f"[LỖI] Không thể trích xuất ID video từ: {args.video}", file=sys.stderr)
        sys.exit(1)

    print(f"[taisrt] Video ID: {video_id}", file=sys.stderr)
    print(f"[taisrt] Output: {args.output}", file=sys.stderr)

    # Đảm bảo thư mục output tồn tại
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

    preferred_langs = [args.lang]
    if '-' not in args.lang:
        preferred_langs.append(args.lang + '-US')
        preferred_langs.append(args.lang + '-GB')

    transcript_data = None
    
    # Chạy yt-dlp kèm vòng lặp retry
    for attempt in range(args.retry):
        try:
            print(f"[taisrt] Thử tải qua yt-dlp (lần {attempt+1}/{args.retry})...", file=sys.stderr)
            transcript_data = fetch_with_yt_dlp(video_id, preferred_langs)
            print(f"[taisrt] yt-dlp tải thành công! ({len(transcript_data)} đoạn)", file=sys.stderr)
            break
        except Exception as e:
            print(f"[LỖI] Lần {attempt+1} thất bại: {str(e)}", file=sys.stderr)
            if attempt < args.retry - 1:
                wait_time = (attempt + 1) * 2
                print(f"[taisrt] Chờ {wait_time}s trước khi thử lại...", file=sys.stderr)
                time.sleep(wait_time)

    if not transcript_data:
        print(f"[LỖI] Không thể tải phụ đề sau {args.retry} lần thử.", file=sys.stderr)
        print(f"[TRỢ GIÚP] Hãy đảm bảo bạn đã cài yt-dlp: pip install yt-dlp[default]", file=sys.stderr)
        sys.exit(1)

    # Lưu SRT
    count = save_as_srt(transcript_data, args.output)
    print(f"[taisrt] Đã lưu {count} đoạn → {args.output}", file=sys.stderr)
    print(f"SUCCESS:{args.output}")

if __name__ == '__main__':
    main()