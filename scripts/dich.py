import os
import re
import logging
import sys
import requests
import json
import concurrent.futures
from datetime import timedelta
import argparse
import time
from langdetect import detect
from threading import Lock
from collections import deque

# Thiết lập logging
logging.basicConfig(filename='dich.log', level=logging.INFO, format='%(asctime)s %(levelname)s:%(message)s')
logger = logging.getLogger(__name__)

# Đặt encoding cho stdout (dự phòng trên Windows)
if sys.platform == "win32":
    import codecs
    sys.stdout = codecs.getwriter("utf-8")(sys.stdout.detach())

RE_TIME_PATTERN = re.compile(r'(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})')

# Sửa từ 1.5 thành 2.5 để khớp với lệnh CMD của bạn
URL_TEMPLATE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"

MAX_CALLS_PER_MINUTE = 10      # Giới hạn 10 lần gọi mỗi phút cho mỗi API key
MAX_SEGMENTS_PER_CHUNK = 70    # Tối đa 70 đoạn phụ đề mỗi chunk
MAX_CHARS_PER_CHUNK = 12000    # Tối đa ~17000 ký tự mỗi chunk (không đếm timetags)

class APIManager:
    """
    Quản lý một tập các API key, đảm bảo gọi không vượt quá MAX_CALLS_PER_MINUTE/key.
    Khi cần key, get_available_key() sẽ trả một key còn quota.
    Nếu không có key nào ngay lập tức, sẽ chờ đến khi một key được giải phóng quota.
    """
    def __init__(self, api_keys):
        self.api_keys = api_keys[:]  # danh sách các key
        # Tham chiếu tới mỗi key: deque chứa timestamps các lần gọi trong vòng 60 giây qua
        self.call_history = {key: deque() for key in api_keys}
        self.lock = Lock()
        self.next_index = 0  # vòng quay index để chọn key tiếp theo

    def get_available_key(self):
        """
        Trả về API key có thể được sử dụng ngay mà không vượt quota.
        Nếu tất cả key đều hết quota, chờ đến lần gọi tiếp theo được giải phóng.
        """
        while True:
            with self.lock:
                now = time.time()
                # Dọn các timestamp đã quá 60 giây
                for key, dq in self.call_history.items():
                    while dq and now - dq[0] > 60:
                        dq.popleft()

                # Tìm key nào có len(dq) < MAX_CALLS_PER_MINUTE
                n = len(self.api_keys)
                for _ in range(n):
                    key = self.api_keys[self.next_index]
                    dq = self.call_history[key]
                    if len(dq) < MAX_CALLS_PER_MINUTE:
                        # Đánh dấu một lần gọi mới
                        dq.append(now)
                        # Cập nhật next_index để lần sau quay tiếp
                        self.next_index = (self.next_index + 1) % n
                        return key
                    # Nếu key này đầy quota, thử key tiếp theo
                    self.next_index = (self.next_index + 1) % n

                # Nếu không có key nào khả dụng ngay, tính thời gian cần chờ
                earliest_release = min((dq[0] for dq in self.call_history.values() if dq),
                                       default=now)
                wait_time = max(0, 60 - (now - earliest_release)) + 0.1
                logger.info(f"Tất cả API keys đều hết quota, chờ {wait_time:.2f}s trước khi retry")
            time.sleep(wait_time)

def load_api_keys(filename='../api.txt'):
    """
    Đọc API keys từ file api.txt trong thư mục backend.
    Mỗi dòng một key. Nếu file không tồn tại hoặc trống, exit.
    """
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        filepath = os.path.join(script_dir, filename)
        if not os.path.exists(filepath):
            error_msg = f"Không tìm thấy file {filepath}. Vui lòng tạo file api.txt và điền ít nhất một API key."
            logger.error(error_msg)
            print(error_msg)
            sys.exit(1)
        with open(filepath, 'r', encoding='utf-8') as f:
            api_keys = [line.strip() for line in f if line.strip()]
        if not api_keys:
            error_msg = "File api.txt trống. Vui lòng điền tối thiểu một API key."
            logger.error(error_msg)
            print(error_msg)
            sys.exit(1)
        logger.info(f"Đã tải {len(api_keys)} API keys từ {filepath}")
        return api_keys
    except Exception as e:
        logger.error(f"Lỗi khi đọc file API keys: {e}")
        sys.exit(1)

def parse_timecode(time_str):
    """Chuyển timecode 'HH:MM:SS,mmm' thành timedelta."""
    h, m, s_ms = time_str.split(':')
    s, ms = s_ms.split(',')
    return timedelta(hours=int(h), minutes=int(m), seconds=int(s), milliseconds=int(ms))

def format_timecode(td):
    """Chuyển timedelta về timecode 'HH:MM:SS,mmm'."""
    total_seconds = int(td.total_seconds())
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    milliseconds = td.microseconds // 1000
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"

def parse_subtitle(subtitle_file):
    """
    Phân tích file SRT: đọc từng đoạn, tách index, timecode và text.
    Trả về list các tuple (index, "start --> end", text).
    """
    print(f"Đang phân tích file phụ đề: {subtitle_file}")
    subtitles = []
    encodings = ['utf-8', 'latin1', 'cp1252', 'windows-1252', 'iso-8859-1']
    
    content = None
    for enc in encodings:
        try:
            with open(subtitle_file, 'r', encoding=enc) as file:
                content = file.read()
            print(f"Đọc file với encoding: {enc}")
            break
        except UnicodeDecodeError:
            continue
    
    if content is None:
        raise ValueError(f"Không thể đọc file phụ đề với các encoding: {encodings}")
    
    blocks = content.strip().split('\n\n')
    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) >= 3:
            idx = lines[0].strip()
            match = RE_TIME_PATTERN.match(lines[1].strip())
            if match:
                start = match.group(1)
                end = match.group(2)
                text = ' '.join(lines[2:]).strip()
                # Loại bỏ các thẻ HTML hoặc ký tự { }
                text = re.sub(r'<[^>]+>', '', text)
                text = re.sub(r'\{[^}]+\}', '', text)
                subtitles.append((idx, f"{start} --> {end}", text))
    print(f"Đã phân tích {len(subtitles)} đoạn phụ đề")
    return subtitles

def add_dummy_segments(srt_data, num_dummies):
    """
    Thêm một số đoạn giả (dummy) vào cuối để cân bằng số chunk khi chia đều cho nhiều API key.
    Mỗi dummy dài 2 giây, text "dummy text".
    """
    if not srt_data:
        return []
    
    last_idx = int(srt_data[-1][0])
    last_end = srt_data[-1][1].split(" --> ")[1]
    last_td = parse_timecode(last_end)
    dummy_list = []
    for i in range(1, num_dummies + 1):
        start_td = last_td + timedelta(seconds=2 * i)
        end_td = start_td + timedelta(seconds=2)
        idx = str(last_idx + i)
        timestr = f"{format_timecode(start_td)} --> {format_timecode(end_td)}"
        dummy_list.append((idx, timestr, "dummy text"))
    return srt_data + dummy_list

def detect_language(text):
    """
    Phát hiện ngôn ngữ của một đoạn text. Nếu bắt đầu bằng "[LỖI", bỏ phần đó ra rồi detect.
    """
    try:
        cleaned = re.sub(r'\[LỖI.*?\]\s*', '', text).strip()
        if not cleaned:
            return None
        return detect(cleaned)
    except Exception as e:
        logger.warning(f"Không thể phát hiện ngôn ngữ: {e}")
        return None

def chunk_subtitles(srt_data):
    """
    Chia srt_data (list các tuple) thành các chunk thỏa điều kiện:
    - Mỗi chunk tối đa MAX_SEGMENTS_PER_CHUNK đoạn
    - Mỗi chunk tổng ký tự (không tính index/timecode) <= MAX_CHARS_PER_CHUNK
    Trả về list các chunk, mỗi chunk là list các tuple (idx, time, text).
    """
    chunks = []
    current = []
    current_chars = 0

    for idx, timecode, text in srt_data:
        text_len = len(text)
        # Nếu thêm vào vượt giới hạn đoạn hoặc ký tự, lưu chunk hiện tại rồi bắt chunk mới
        if current and (len(current) >= MAX_SEGMENTS_PER_CHUNK or current_chars + text_len > MAX_CHARS_PER_CHUNK):
            chunks.append(current)
            current = []
            current_chars = 0
        current.append((idx, timecode, text))
        current_chars += text_len

    if current:
        chunks.append(current)
    return chunks

# --- THAY ĐỔI 2: Cập nhật hàm gọi API để dùng Header thay vì URL param ---
def call_api_and_get_text(prompt, api_manager, timeout=500):
    """
    Gọi API Gemini với payload prompt.
    Trả về text nếu thành công, hoặc None nếu lỗi / model không trả nội dung.
    """
    api_key = api_manager.get_available_key()

    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key
    }

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt}
                ]
            }
        ]
    }

    url = URL_TEMPLATE

    try:
        resp = requests.post(
            url,
            headers=headers,
            data=json.dumps(payload),
            timeout=timeout
        )

        if resp.status_code != 200:
            logger.error(f"API trả code {resp.status_code}: {resp.text[:400]}")
            return None

        j = resp.json()

        try:
            candidates = j.get("candidates", [])
            if not candidates:
                logger.error(f"Response không có candidates: {j}")
                return None

            content = candidates[0].get("content", {})
            parts = content.get("parts", [])

            if not parts:
                logger.error(f"Response không có parts: {j}")
                return None

            text = parts[0].get("text", None)

            if not text:
                logger.error(f"Model không trả text: {j}")
                return None

            return text

        except Exception as e:
            logger.error(f"Lỗi parse JSON response: {e} -- raw: {j}")
            return None

    except Exception as e:
        logger.error(f"Exception khi gọi API: {e}")
        return None


def ensure_full_translation(chunk, translated_result, api_manager, target_lang, context_text=""):
    """
    Kiểm tra thêm: nếu vẫn còn [LỖI_PARSE] hoặc thiếu idx -> tự động gọi process_chunk
    cho từng idx bị lỗi hoặc nhóm nhỏ để đảm bảo không mất đoạn.
    """
    # map current results by idx
    by_idx = {idx: (time, text) for idx, time, text in translated_result}
    final = []
    for idx, orig_time, orig_text in chunk:
        if idx in by_idx:
            timecode, text = by_idx[idx]
            if text.startswith("[LỖI_PARSE]") or len(text.strip()) < 3:
                # retry this idx alone with neighbor
                logger.info(f"Retry cho đoạn {idx} do text ngắn/ lỗi")
                # lấy đoạn hiện tại và đoạn kế tiếp (nếu có)
                next_seg = next((c for c in chunk if int(c[0]) == int(idx) + 1), None)
                to_retry = [(idx, orig_time, orig_text)]
                if next_seg:
                    to_retry.append(next_seg)
                retry_res = process_chunk(to_retry, api_manager, target_lang, context_text)
                # tìm kết quả cho idx trong retry_res
                found = next((r for r in retry_res if r[0] == idx), None)
                if found:
                    final.append(found)
                else:
                    final.append((idx, orig_time, f"[LỖI_PARSE] {orig_text}"))
            else:
                final.append((idx, orig_time, text))
        else:
            # missing -> retry this single idx
            logger.info(f"Missing idx {idx} trong kết quả, gọi lại API riêng cho idx này")
            # tìm orig_text
            retry_res = process_chunk([(idx, orig_time, orig_text)], api_manager, target_lang, context_text)
            if retry_res and retry_res[0][2] and not retry_res[0][2].startswith("[LỖI"):
                final.append(retry_res[0])
            else:
                final.append((idx, orig_time, f"[LỖI_PARSE] {orig_text}"))
    return final


def process_chunk(chunk, api_manager, target_lang, context_text=""):
    """
    Gộp nội dung các đoạn trong chunk bằng token fkhsdj(<idx>) (không gửi timecodes).
    Sau khi nhận về, parse token theo CHỈ SỐ trong token (không map theo thứ tự).
    Nếu token không parse được, thử fallback (split bằng regex, JSON, hoặc chia nhóm nhỏ).
    Trả về list (idx, timecode, translated_text).
    """
    to_translate = []
    kept = []
    for idx, timecode, text in chunk:
        orig_lang = detect_language(text)
        if orig_lang == target_lang and "[LỖI" not in text:
            kept.append((idx, timecode, text))
        else:
            to_translate.append((idx, timecode, text))

    if not to_translate:
        return kept

    # --- Build concatenated string with token immediately after each segment except last ---
    parts = []
    for i, (idx, timecode, text) in enumerate(to_translate):
        cleaned = ' '.join(text.splitlines()).strip()
        if i < len(to_translate) - 1:
            # no space before token, single space after, matches your example: "...fromfkhsdj1 Exo..."
            parts.append(f"{cleaned}fkhsdj({idx}) ")
        else:
            parts.append(cleaned)
    concatenated = ''.join(parts).strip()

    # Prompt: bắt model giữ nguyên token fkhsdj(<n>)
    ctx = f"Ngữ cảnh: {context_text}. " if context_text else ""
    prompt = (
        f"Dịch sang {target_lang}. {ctx}"
        "RẤT QUAN TRỌNG: KHÔNG thêm số thứ tự, KHÔNG thêm timecodes, KHÔNG chèn chú thích. "
        "KHÔNG XÓA hoặc THAY ĐỔI bất kỳ token nào ở dạng fkhsdj(<số>) — ví dụ fkhsdj(46).\n\n"
        "TRẢ VỀ CHỈ MỘT CHUỖI VĂN BẢN ĐÃ DỊCH, giữ nguyên tất cả token fkhsdj(<số>).\n\n"
        f"{concatenated}"
    )

    translated_text = call_api_and_get_text(prompt, api_manager)

    # ---------- Robust parse: try mapping by token index ----------
    def parse_using_index_tokens(text):
        if not text:
            return None
        pattern = re.compile(r'fkhsdj\(\s*(\d+)\s*\)', re.IGNORECASE)
        matches = list(pattern.finditer(text))
        if not matches:
            return None
        mapping = {}
        prev = 0
        for m in matches:
            seg = text[prev:m.start()].strip()
            idx_tok = m.group(1)
            # If multiple tokens for same idx happen, keep the longer segment (safety)
            if idx_tok in mapping:
                if len(seg) > len(mapping[idx_tok]):
                    mapping[idx_tok] = seg
            else:
                mapping[idx_tok] = seg
            prev = m.end()
        # final part after last token -> belongs to last original segment
        final_seg = text[prev:].strip()
        last_orig_idx = to_translate[-1][0]
        if final_seg:
            mapping[str(int(last_orig_idx))] = final_seg
        # Ensure mapping keys are strings of ints; return mapping if it covers at least one token
        return mapping if mapping else None

    mapping = parse_using_index_tokens(translated_text)

    # ---------- Fallback 1: split by token-like pattern and map by order ----------
    if mapping is None:
        # split by token pattern, keep empty parts (so positions preserved)
        split_parts = re.split(r'fkhsdj\(\s*\d+\s*\)', (translated_text or ''), flags=re.IGNORECASE)
        split_parts = [p.strip() for p in split_parts]
        # Remove any leading/trailing empty strings only if they are true empties
        # If number of non-empty parts equals to_translate length -> map by order
        non_empty = [p for p in split_parts if p != ""]
        if len(non_empty) == len(to_translate):
            mapping = {}
            for (orig_idx, _, _), seg in zip(to_translate, non_empty):
                mapping[str(int(orig_idx))] = seg
        else:
            mapping = None

    # ---------- Fallback 2: ask API to return JSON mapping (if still None) ----------
    if mapping is None:
        prompt_json = (
            f"Dịch sang {target_lang}. {ctx}"
            "KHÔNG GHI TIME CODES. Trả LẠI DƯỚI DẠNG JSON object mapping mỗi index sang đoạn đã dịch.\n"
            'Ví dụ: {"46": "dịch đoạn 46", "47": "dịch đoạn 47"}\n\n'
            f"Dựa trên input (mỗi đoạn cách nhau token fkhsdj(<index>)):\n\n{concatenated}\n\n"
            "TRẢ VỀ CHỈ MỘT JSON object duy nhất. KHÔNG kèm văn bản khác."
        )
        json_text = call_api_and_get_text(prompt_json, api_manager)
        if json_text:
            # extract JSON substring
            m = re.search(r'(\{[\s\S]*\})', json_text)
            if m:
                try:
                    parsed_json = json.loads(m.group(1))
                    # normalize keys to strings without leading zeros/spaces
                    mapping = {str(int(k)): v.strip() for k, v in parsed_json.items()}
                except Exception as e:
                    logger.error(f"Không parse JSON từ response khi fallback JSON: {e}, raw: {json_text[:400]}")
                    mapping = None

    # ---------- Fallback 3: chia nhóm nhỏ và retry ----------
    mapped_results = []
    if mapping is None:
        logger.warning("Không parse mapping hoàn chỉnh từ response. Fallback: chia nhóm nhỏ và retry để tránh mất đoạn.")
        group_size = 5
        for i in range(0, len(to_translate), group_size):
            small = to_translate[i:i+group_size]
            # build small concatenated
            small_parts = []
            for j, (idx, timecode, text) in enumerate(small):
                cleaned = ' '.join(text.splitlines()).strip()
                if j < len(small) - 1:
                    small_parts.append(f"{cleaned}fkhsdj({idx}) ")
                else:
                    small_parts.append(cleaned)
            small_concat = ''.join(small_parts).strip()
            p_small = (
                f"Dịch sang {target_lang}. KHÔNG kèm timecodes. Giữ nguyên tokens fkhsdj(<index>).\n\n"
                f"{small_concat}"
            )
            small_res = call_api_and_get_text(p_small, api_manager)
            # try parse by index tokens
            small_map = None
            if small_res:
                small_map = parse_using_index_tokens(small_res)
            # fallback to splitting
            if small_map is None and small_res:
                sp = re.split(r'fkhsdj\(\s*\d+\s*\)', small_res, flags=re.IGNORECASE)
                non_empty_sp = [p.strip() for p in sp if p.strip() != ""]
                if len(non_empty_sp) == len(small):
                    small_map = {}
                    for (orig_idx, _, _), seg in zip(small, non_empty_sp):
                        small_map[str(int(orig_idx))] = seg
            # if still none -> mark as error
            if small_map is None:
                for idx, timecode, text in small:
                    mapped_results.append((idx, timecode, f"[LỖI_PARSE] {text}"))
            else:
                for idx, timecode, _ in small:
                    val = small_map.get(str(int(idx)), "")
                    if not val:
                        mapped_results.append((idx, timecode, f"[LỖI_PARSE] " + next((t for (i, _, t) in small if i == idx), "")))
                    else:
                        mapped_results.append((idx, timecode, val))

        # combine kept + mapped_results and return
        result_list = kept + mapped_results
        try:
            result_list.sort(key=lambda x: int(x[0]))
        except Exception:
            pass
        return result_list

    # ---------- Nếu có mapping: build mapped list in original order ----------
    mapped = []
    for orig_idx, orig_time, orig_text in to_translate:
        seg_txt = mapping.get(str(int(orig_idx)), "").strip()
        if not seg_txt:
            # nếu mapping thiếu, đánh dấu lỗi nhưng giữ text gốc
            seg_txt = f"[LỖI_PARSE] {orig_text}"
        mapped.append((orig_idx, orig_time, seg_txt))

    result_list = kept + mapped
    try:
        result_list.sort(key=lambda x: int(x[0]))
    except Exception:
        pass
    return result_list


def translate_srt(srt_data, target_lang='vi', context_text=""):
    """
    Dịch toàn bộ file SRT:
    1. Thêm dummy segments để chia đều cho số API key (nếu cần).
    2. Chia thành chunks theo chunk_subtitles().
    3. Dùng ThreadPoolExecutor để xử lý song song từng chunk với process_chunk().
    4. Kết hợp kết quả, sort lại theo idx.
    """
    start = time.time()
    api_keys = load_api_keys()
    api_manager = APIManager(api_keys)

    # Thêm dummy segments để chia đều
    srt_with_dummy = add_dummy_segments(srt_data, len(api_keys))
    # Chia thành chunks
    chunks = chunk_subtitles(srt_with_dummy)

    final_results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(api_keys)) as executor:
        future_to_chunk = {}
        for chunk in chunks:
            fut = executor.submit(process_chunk, chunk, api_manager, target_lang, context_text)
            future_to_chunk[fut] = chunk

        for future in concurrent.futures.as_completed(future_to_chunk):
            orig_chunk = future_to_chunk[future]
            try:
                res = future.result()
                checked = ensure_full_translation(orig_chunk, res, api_manager, target_lang, context_text)
                final_results.extend(checked)
            except Exception as e:
                logger.error(f"Chunk processing exception: {e}")
                # nếu exception - gắn lỗi cho tất cả idx trong orig_chunk
                for idx, timecode, text in orig_chunk:
                    final_results.append((idx, timecode, f"[LỖI_EXCEPTION] {text}"))


    # final_results chứa danh sách các tuple (idx, timecode, text).
    # Nhưng vì có dummy data, ta chỉ cần giữ những idx thuộc srt_data ban đầu
    original_idxs = set(idx for idx, _, _ in srt_data)
    filtered = [seg for seg in final_results if seg[0] in original_idxs]
    # Sort lại theo idx
    filtered.sort(key=lambda x: int(x[0]))

    end = time.time()
    logger.info(f"Hoàn thành dịch SRT trong {end - start:.2f} giây")
    return filtered

def save_translated_srt(translated_data, output_file):
    """
    Lưu kết quả dịch vào file SRT:
    Mỗi đoạn: idx \n timecode \n text \n\n
    """
    lines = []
    for idx, timecode, text in translated_data:
        lines.append(f"{idx}\n{timecode}\n{text}")
    content = "\n\n".join(lines)
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(content)
    logger.info(f"Đã lưu file dịch tại: {output_file}")
    
def _test_parse_simulated():
    # giả lập to_translate
    to_translate = [("1", "00:00:03,959 --> 00:00:05,599", "hello everyone my name is Nicholas from"),
                    ("2", "00:00:05,599 --> 00:00:07,839", "Exo games team and welcome to a new C++"),
                    ("3", "00:00:07,839 --> 00:00:10,320", "under Engine 5 tutorial today we are")]
    # giả lập model trả về đúng form (không timecode)
    simulated = "hello everyone my name is Nicholas fromfkhsdj(1) Exo games team and welcome to a new C++fkhsdj(2) under Engine 5 tutorial today we are"
    # chạy parser nhỏ
    pattern = re.compile(r'fkhsdj\(\s*(\d+)\s*\)', re.IGNORECASE)
    matches = list(pattern.finditer(simulated))
    prev = 0
    mapping = {}
    for m in matches:
        seg = simulated[prev:m.start()].strip()
        mapping[m.group(1)] = seg
        prev = m.end()
    mapping[str(int(to_translate[-1][0]))] = simulated[prev:].strip()
    print("Mapping:", mapping)
# _test_parse_simulated()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Translate SRT file to ngôn ngữ đích.")
    parser.add_argument("subtitle_file", help="Đường dẫn tới file SRT đầu vào")
    parser.add_argument("output_file", help="Đường dẫn tới file SRT đầu ra đã dịch")
    parser.add_argument("--target-lang", default="vi", help="Mã ngôn ngữ đích (ví dụ: vi, en, es)")
    parser.add_argument("--context", default="", help="Ngữ cảnh cho bản dịch (tùy chọn)")
    args = parser.parse_args()

    subtitle_file = args.subtitle_file
    output_file = args.output_file
    context_text = args.context
    if not os.path.exists(subtitle_file):
        logger.error(f"File không tồn tại: {subtitle_file}")
        print(f"File không tồn tại: {subtitle_file}")
        sys.exit(1)

    try:
        data = parse_subtitle(subtitle_file)
        if not data:
            logger.error("Không có phụ đề hợp lệ!")
            print("Không có phụ đề hợp lệ!")
            sys.exit(1)
        # Truyền context_text vào hàm translate_srt
        translated = translate_srt(data, args.target_lang, context_text)
        save_translated_srt(translated, output_file)
        print(f"Hoàn thành dịch, đã lưu kết quả tại {output_file}")
    except Exception as e:
        logger.error(f"Lỗi: {e}")
        print(f"Lỗi: {e}")
        sys.exit(1)