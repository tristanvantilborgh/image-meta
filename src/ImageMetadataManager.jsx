import { useState, useCallback, useRef, useEffect } from "react";

// ── EXIF Parser (pure JS, no dependencies) ──
function readExifData(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const tags = {};
  
  if (view.getUint16(0) !== 0xFFD8) return tags; // Not JPEG
  
  let offset = 2;
  while (offset < view.byteLength - 1) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFE1) { // APP1 (EXIF)
      const length = view.getUint16(offset + 2);
      const exifOffset = offset + 4;
      // Check for "Exif\0\0"
      if (view.getUint32(exifOffset) === 0x45786966 && view.getUint16(exifOffset + 4) === 0x0000) {
        parseExif(view, exifOffset + 6, tags);
      }
      offset += 2 + length;
    } else if ((marker & 0xFF00) === 0xFF00) {
      if (marker === 0xFFDA) break; // Start of scan
      const len = view.getUint16(offset + 2);
      offset += 2 + len;
    } else {
      break;
    }
  }
  
  // Also extract IPTC (APP13)
  offset = 2;
  while (offset < view.byteLength - 1) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFED) { // APP13 (IPTC)
      const length = view.getUint16(offset + 2);
      parseIPTC(view, offset + 4, length - 2, tags);
      offset += 2 + length;
    } else if ((marker & 0xFF00) === 0xFF00) {
      if (marker === 0xFFDA) break;
      const len = view.getUint16(offset + 2);
      offset += 2 + len;
    } else {
      break;
    }
  }
  
  return tags;
}

const EXIF_TAGS = {
  0x010F: "Make", 0x0110: "Model", 0x0112: "Orientation",
  0x011A: "XResolution", 0x011B: "YResolution", 0x0128: "ResolutionUnit",
  0x0131: "Software", 0x0132: "DateTime",
  0x829A: "ExposureTime", 0x829D: "FNumber", 0x8822: "ExposureProgram",
  0x8827: "ISOSpeedRatings", 0x9000: "ExifVersion",
  0x9003: "DateTimeOriginal", 0x9004: "DateTimeDigitized",
  0x9201: "ShutterSpeedValue", 0x9202: "ApertureValue",
  0x9203: "BrightnessValue", 0x9204: "ExposureBiasValue",
  0x9205: "MaxApertureValue", 0x9207: "MeteringMode",
  0x9208: "LightSource", 0x9209: "Flash",
  0x920A: "FocalLength", 0xA001: "ColorSpace",
  0xA002: "PixelXDimension", 0xA003: "PixelYDimension",
  0xA405: "FocalLengthIn35mmFilm", 0xA406: "SceneCaptureType",
  0xA420: "ImageUniqueID", 0xA431: "BodySerialNumber",
  0xA432: "LensInfo", 0xA433: "LensMake", 0xA434: "LensModel",
  0x9286: "UserComment", 0x010E: "ImageDescription",
  0x8298: "Copyright", 0x013B: "Artist",
  0xA401: "CustomRendered", 0xA402: "ExposureMode",
  0xA403: "WhiteBalance", 0xA404: "DigitalZoomRatio",
  0xA408: "Contrast", 0xA409: "Saturation", 0xA40A: "Sharpness",
};

const GPS_TAGS = {
  0x0001: "GPSLatitudeRef", 0x0002: "GPSLatitude",
  0x0003: "GPSLongitudeRef", 0x0004: "GPSLongitude",
  0x0005: "GPSAltitudeRef", 0x0006: "GPSAltitude",
};

function parseExif(view, tiffStart, tags) {
  try {
    const bigEndian = view.getUint16(tiffStart) === 0x4D4D;
    const g16 = (o) => view.getUint16(o, !bigEndian);
    const g32 = (o) => view.getUint32(o, !bigEndian);
    
    const ifdOffset = g32(tiffStart + 4);
    parseIFD(view, tiffStart, tiffStart + ifdOffset, g16, g32, tags, EXIF_TAGS, bigEndian);
    
    // Look for ExifIFD pointer (tag 0x8769)
    const numEntries = g16(tiffStart + ifdOffset);
    for (let i = 0; i < numEntries; i++) {
      const entryOffset = tiffStart + ifdOffset + 2 + i * 12;
      const tag = g16(entryOffset);
      if (tag === 0x8769) {
        const exifIFDOffset = g32(entryOffset + 8);
        parseIFD(view, tiffStart, tiffStart + exifIFDOffset, g16, g32, tags, EXIF_TAGS, bigEndian);
      }
      if (tag === 0x8825) {
        const gpsIFDOffset = g32(entryOffset + 8);
        parseIFD(view, tiffStart, tiffStart + gpsIFDOffset, g16, g32, tags, GPS_TAGS, bigEndian);
      }
    }
  } catch (e) { /* silently fail on corrupt EXIF */ }
}

function parseIFD(view, tiffStart, ifdStart, g16, g32, tags, tagMap, bigEndian) {
  try {
    const numEntries = g16(ifdStart);
    for (let i = 0; i < numEntries; i++) {
      const entryOffset = ifdStart + 2 + i * 12;
      if (entryOffset + 12 > view.byteLength) break;
      const tag = g16(entryOffset);
      const type = g16(entryOffset + 2);
      const count = g32(entryOffset + 4);
      const valueOffset = entryOffset + 8;
      const tagName = tagMap[tag];
      if (!tagName) continue;
      
      try {
        let value;
        const typeSize = [0,1,1,2,4,8,1,1,2,4,8,4,8][type] || 1;
        const totalSize = typeSize * count;
        const dataOffset = totalSize > 4 ? tiffStart + g32(valueOffset) : valueOffset;
        
        if (type === 2) { // ASCII
          let str = "";
          for (let j = 0; j < count - 1 && dataOffset + j < view.byteLength; j++) {
            str += String.fromCharCode(view.getUint8(dataOffset + j));
          }
          value = str;
        } else if (type === 3) { // SHORT
          value = count === 1 ? g16(valueOffset) : g16(dataOffset);
        } else if (type === 4) { // LONG
          value = g32(totalSize > 4 ? dataOffset : valueOffset);
        } else if (type === 5) { // RATIONAL
          const num = g32(dataOffset);
          const den = g32(dataOffset + 4);
          if (tagName === "ExposureTime") {
            value = den === 0 ? "0" : (num < den ? `1/${Math.round(den/num)}` : `${(num/den).toFixed(1)}`);
          } else if (tagName === "FNumber" || tagName === "ApertureValue" || tagName === "MaxApertureValue") {
            value = den === 0 ? "0" : `f/${(num/den).toFixed(1)}`;
          } else if (tagName === "FocalLength") {
            value = den === 0 ? "0" : `${(num/den).toFixed(1)} mm`;
          } else if (tagName === "GPSLatitude" || tagName === "GPSLongitude") {
            // Read 3 rationals
            const d = g32(dataOffset) / g32(dataOffset + 4);
            const m = g32(dataOffset + 8) / g32(dataOffset + 12);
            const s = g32(dataOffset + 16) / g32(dataOffset + 20);
            value = `${d}° ${m}' ${s.toFixed(2)}"`;
          } else {
            value = den === 0 ? "0" : `${(num/den).toFixed(2)}`;
          }
        } else if (type === 10) { // SRATIONAL
          const num = view.getInt32(dataOffset, !bigEndian);
          const den = view.getInt32(dataOffset + 4, !bigEndian);
          if (tagName === "ExposureBiasValue") {
            value = den === 0 ? "0" : `${(num/den).toFixed(1)} EV`;
          } else {
            value = den === 0 ? "0" : `${(num/den).toFixed(2)}`;
          }
        } else {
          value = g16(valueOffset);
        }
        
        tags[tagName] = value;
      } catch(e) { /* skip unreadable tag */ }
    }
  } catch(e) { /* skip corrupt IFD */ }
}

function parseIPTC(view, start, length, tags) {
  try {
    const IPTC_TAGS = {
      5: "ObjectName", 15: "Category", 20: "SupplementalCategories",
      25: "Keywords", 40: "SpecialInstructions", 55: "DateCreated",
      80: "ByLine", 85: "ByLineTitle", 90: "City",
      92: "SubLocation", 95: "ProvinceState", 100: "CountryCode",
      101: "Country", 105: "OriginalTransmissionReference",
      110: "Credit", 115: "Source", 116: "CopyrightNotice",
      120: "Caption", 122: "Writer",
    };
    
    // Skip Photoshop header if present
    let offset = start;
    const end = start + length;
    // Look for 8BIM markers or 1C markers
    while (offset < end - 4) {
      if (view.getUint8(offset) === 0x1C) {
        const recordType = view.getUint8(offset + 1);
        const datasetType = view.getUint8(offset + 2);
        const dataLen = view.getUint16(offset + 3);
        if (recordType === 2 && IPTC_TAGS[datasetType]) {
          let str = "";
          for (let j = 0; j < dataLen && offset + 5 + j < end; j++) {
            str += String.fromCharCode(view.getUint8(offset + 5 + j));
          }
          const name = `IPTC:${IPTC_TAGS[datasetType]}`;
          if (tags[name]) {
            tags[name] += `; ${str}`;
          } else {
            tags[name] = str;
          }
        }
        offset += 5 + dataLen;
      } else {
        offset++;
      }
    }
  } catch(e) { /* skip */ }
}

function formatExposureProgram(v) {
  const m = { 0:"Not Defined", 1:"Manual", 2:"Program AE", 3:"Aperture Priority", 4:"Shutter Priority", 5:"Creative", 6:"Action", 7:"Portrait", 8:"Landscape" };
  return m[v] || String(v);
}
function formatMeteringMode(v) {
  const m = { 0:"Unknown", 1:"Average", 2:"Center-weighted", 3:"Spot", 4:"Multi-spot", 5:"Multi-segment", 6:"Partial" };
  return m[v] || String(v);
}
function formatFlash(v) {
  return (v & 1) ? "Fired" : "Did not fire";
}
function formatWhiteBalance(v) {
  return v === 0 ? "Auto" : v === 1 ? "Manual" : String(v);
}
function formatSceneCapture(v) {
  const m = { 0:"Standard", 1:"Landscape", 2:"Portrait", 3:"Night" };
  return m[v] || String(v);
}

// ── Storage helpers ──
function getStorageKey(fileName, fileSize) {
  return `meta:${fileName}:${fileSize}`;
}

// ── Main App ──
export default function ImageMetadataManager() {
  const [files, setFiles] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [showAllMeta, setShowAllMeta] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState(null);
  const fileInputRef = useRef(null);
  const [editData, setEditData] = useState({});

  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  }, []);

  const processFile = useCallback(async (file) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const arrayBuffer = e.target.result;
        const exif = readExifData(arrayBuffer);
        
        const imgReader = new FileReader();
        imgReader.onload = async (ev) => {
          const dataUrl = ev.target.result;
          
          // Get image dimensions
          const img = new Image();
          img.onload = async () => {
            // Try to load saved metadata
            let savedMeta = {};
            try {
              const stored = localStorage.getItem(getStorageKey(file.name, file.size));
              if (stored) savedMeta = JSON.parse(stored);
            } catch(e) { /* no saved data */ }
            
            resolve({
              name: file.name,
              size: file.size,
              type: file.type,
              lastModified: new Date(file.lastModified).toLocaleString(),
              dataUrl,
              width: img.naturalWidth,
              height: img.naturalHeight,
              exif,
              userMeta: {
                title: "", description: "", keywords: "", creator: "",
                copyright: "", credit: "", city: "", country: "",
                instructions: "", usageTerms: "", aiSystem: "",
                aiPrompt: "", aiPromptWriter: "", digitalSourceType: "Camera",
                ...savedMeta,
              },
            });
          };
          img.src = dataUrl;
        };
        imgReader.readAsDataURL(file);
      };
      reader.readAsArrayBuffer(file);
    });
  }, []);

  const handleFiles = useCallback(async (fileList) => {
    const imageFiles = Array.from(fileList).filter(f => f.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      showToast("Please drop image files (JPEG, PNG, etc.)", "error");
      return;
    }
    const processed = await Promise.all(imageFiles.map(processFile));
    setFiles(prev => {
      const next = [...prev, ...processed];
      if (prev.length === 0 && processed.length > 0) setSelectedIdx(0);
      return next;
    });
    showToast(`${processed.length} image${processed.length > 1 ? "s" : ""} loaded`);
  }, [processFile, showToast]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const onDragOver = useCallback((e) => { e.preventDefault(); setDragOver(true); }, []);
  const onDragLeave = useCallback(() => setDragOver(false), []);

  const selected = selectedIdx !== null ? files[selectedIdx] : null;

  const startEdit = useCallback(() => {
    if (!selected) return;
    setEditData({ ...selected.userMeta });
    setEditMode(true);
  }, [selected]);

  const saveEdit = useCallback(() => {
    if (selectedIdx === null) return;
    const updated = [...files];
    updated[selectedIdx] = { ...updated[selectedIdx], userMeta: { ...editData } };
    setFiles(updated);
    setEditMode(false);
    
    try {
      localStorage.setItem(
        getStorageKey(updated[selectedIdx].name, updated[selectedIdx].size),
        JSON.stringify(editData)
      );
      showToast("Metadata saved successfully");
    } catch(e) {
      showToast("Saved to session (storage unavailable)", "error");
    }
  }, [selectedIdx, files, editData, showToast]);

  const cancelEdit = useCallback(() => {
    setEditMode(false);
    setEditData({});
  }, []);

  const removeFile = useCallback((idx) => {
    setFiles(prev => {
      const next = prev.filter((_, i) => i !== idx);
      if (selectedIdx === idx) {
        setSelectedIdx(next.length > 0 ? Math.min(idx, next.length - 1) : null);
      } else if (selectedIdx > idx) {
        setSelectedIdx(selectedIdx - 1);
      }
      return next;
    });
  }, [selectedIdx]);

  const exportMetadata = useCallback(() => {
    if (!selected) return;
    const data = {
      fileName: selected.name,
      fileSize: selected.size,
      fileType: selected.type,
      dimensions: `${selected.width} × ${selected.height}`,
      technicalMetadata: selected.exif,
      descriptiveMetadata: selected.userMeta,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selected.name.replace(/\.[^.]+$/, "")}_metadata.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Metadata exported as JSON");
  }, [selected, showToast]);

  // ── Key technical fields for summary ──
  const techSummary = selected ? [
    { label: "Camera", value: [selected.exif.Make, selected.exif.Model].filter(Boolean).join(" ") || "—" },
    { label: "Lens", value: selected.exif.LensModel || "—" },
    { label: "Shutter Speed", value: selected.exif.ExposureTime || "—" },
    { label: "Aperture", value: selected.exif.FNumber || "—" },
    { label: "ISO", value: selected.exif.ISOSpeedRatings || "—" },
    { label: "Focal Length", value: selected.exif.FocalLength || "—" },
    { label: "Exposure Program", value: selected.exif.ExposureProgram !== undefined ? formatExposureProgram(selected.exif.ExposureProgram) : "—" },
    { label: "Metering", value: selected.exif.MeteringMode !== undefined ? formatMeteringMode(selected.exif.MeteringMode) : "—" },
    { label: "Flash", value: selected.exif.Flash !== undefined ? formatFlash(selected.exif.Flash) : "—" },
    { label: "White Balance", value: selected.exif.WhiteBalance !== undefined ? formatWhiteBalance(selected.exif.WhiteBalance) : "—" },
    { label: "Date Taken", value: selected.exif.DateTimeOriginal || selected.exif.DateTime || "—" },
    { label: "Dimensions", value: `${selected.width} × ${selected.height} px` },
  ] : [];

  // Descriptive fields config
  const descriptiveFields = [
    { key: "title", label: "Title", type: "text", help: "IPTC Object Name" },
    { key: "description", label: "Description / Caption", type: "textarea", help: "IPTC Caption-Abstract — describe what is visible" },
    { key: "keywords", label: "Keywords", type: "text", help: "Semicolon-separated (e.g., landscape; sunset; mountains)" },
    { key: "creator", label: "Creator / Photographer", type: "text", help: "IPTC By-line" },
    { key: "city", label: "City", type: "text", help: "IPTC City" },
    { key: "country", label: "Country", type: "text", help: "IPTC Country" },
  ];

  const adminFields = [
    { key: "copyright", label: "Copyright Notice", type: "text", help: "E.g., © 2026 Company Name" },
    { key: "credit", label: "Credit Line", type: "text", help: "Credit displayed alongside the image" },
    { key: "usageTerms", label: "Rights / Usage Terms", type: "text", help: "Plain-language licensing" },
    { key: "instructions", label: "Special Instructions", type: "text", help: "Handling instructions for recipients" },
    { key: "digitalSourceType", label: "Digital Source Type", type: "select", options: ["Camera", "Scanner", "Composite", "AI-Generated", "Other"], help: "IPTC Digital Source Type" },
    { key: "aiSystem", label: "AI System Used", type: "text", help: "IPTC 2025.1 — e.g., DALL-E 3, Midjourney" },
    { key: "aiPrompt", label: "AI Prompt Information", type: "textarea", help: "IPTC 2025.1 — the prompt used" },
    { key: "aiPromptWriter", label: "AI Prompt Writer", type: "text", help: "IPTC 2025.1 — who wrote the prompt" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#0F1419", color: "#E8ECF0", fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap');
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #1A2029; }
        ::-webkit-scrollbar-thumb { background: #3A4553; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #4A90D9; }
        
        .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #1E2730; }
        .meta-cell { padding: 8px 12px; background: #141B22; }
        .meta-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: #6B7A8D; font-weight: 500; margin-bottom: 2px; font-family: 'JetBrains Mono', monospace; }
        .meta-value { font-size: 13px; color: #C8D2DC; font-weight: 500; word-break: break-word; }
        .meta-value.highlight { color: #4A90D9; font-weight: 600; }
        
        .field-group { margin-bottom: 14px; }
        .field-label { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
        .field-label span:first-child { font-size: 12px; font-weight: 600; color: #A0AEBB; }
        .field-label span:last-child { font-size: 10px; color: #4E5D6B; font-family: 'JetBrains Mono', monospace; }
        .field-input { width: 100%; padding: 8px 12px; background: #0F1419; border: 1px solid #2A3440; border-radius: 6px; color: #E0E6EC; font-size: 13px; font-family: 'DM Sans', sans-serif; outline: none; transition: border-color 0.2s; }
        .field-input:focus { border-color: #4A90D9; box-shadow: 0 0 0 2px rgba(74,144,217,0.15); }
        .field-input::placeholder { color: #3A4553; }
        textarea.field-input { resize: vertical; min-height: 60px; line-height: 1.5; }
        select.field-input { cursor: pointer; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%236B7A8D' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; }
        
        .file-thumb { width: 44px; height: 44px; border-radius: 6px; object-fit: cover; flex-shrink: 0; border: 2px solid transparent; transition: all 0.15s; }
        .file-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; transition: background 0.15s; border-left: 3px solid transparent; position: relative; }
        .file-item:hover { background: #1A2029; }
        .file-item.active { background: #141E2B; border-left-color: #4A90D9; }
        .file-item.active .file-thumb { border-color: #4A90D9; }
        .file-item .remove-btn { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); opacity: 0; width: 22px; height: 22px; border-radius: 50%; background: #2A1A1A; border: none; color: #D94A4A; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: opacity 0.15s; }
        .file-item:hover .remove-btn { opacity: 1; }
        .file-item .remove-btn:hover { background: #3A1A1A; }
        
        .btn { padding: 7px 16px; border-radius: 6px; border: none; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; font-family: 'DM Sans', sans-serif; display: inline-flex; align-items: center; gap: 6px; }
        .btn-primary { background: #4A90D9; color: white; }
        .btn-primary:hover { background: #5A9FE6; }
        .btn-secondary { background: #1E2730; color: #A0AEBB; border: 1px solid #2A3440; }
        .btn-secondary:hover { background: #252F3A; color: #E0E6EC; }
        .btn-success { background: #1A5C3A; color: #6FD9A0; }
        .btn-success:hover { background: #1D6B43; }
        .btn-danger { background: transparent; color: #8A9AAD; border: 1px solid #2A3440; }
        .btn-danger:hover { background: #2A1A1A; color: #D94A4A; border-color: #D94A4A; }
        
        .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: #4A90D9; font-weight: 700; padding: 12px 16px 8px; font-family: 'JetBrains Mono', monospace; }
        
        .tag-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; font-family: 'JetBrains Mono', monospace; }
        .tag-exif { background: #1A2A3A; color: #4A90D9; }
        .tag-iptc { background: #1A3A2A; color: #4AD98A; }
        .tag-user { background: #3A2A1A; color: #D9A04A; }
        
        .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); padding: 10px 24px; border-radius: 8px; font-size: 13px; font-weight: 500; z-index: 999; animation: toastIn 0.3s ease; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
        .toast-success { background: #1A5C3A; color: #6FD9A0; border: 1px solid #2A6B4A; }
        .toast-error { background: #5C1A1A; color: #D96F6F; border: 1px solid #6B2A2A; }
        @keyframes toastIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
        
        .drop-zone { border: 2px dashed #2A3440; border-radius: 12px; padding: 48px 24px; text-align: center; cursor: pointer; transition: all 0.2s; }
        .drop-zone:hover, .drop-zone.active { border-color: #4A90D9; background: rgba(74,144,217,0.04); }
        .drop-zone.active { border-color: #4AD98A; background: rgba(74,217,138,0.04); }
        
        .all-meta-row { display: grid; grid-template-columns: 180px 1fr; gap: 1px; background: #1E2730; }
        .all-meta-row > div { padding: 6px 12px; background: #141B22; font-size: 12px; }
        .all-meta-row > div:first-child { color: #6B7A8D; font-family: 'JetBrains Mono', monospace; font-size: 11px; }
        .all-meta-row > div:last-child { color: #C8D2DC; word-break: break-all; }
        .all-meta-row:nth-child(even) > div { background: #0F1419; }
        
        .panel { background: #141B22; border: 1px solid #1E2730; border-radius: 10px; overflow: hidden; }
        
        .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #3A4553; gap: 8px; }
        .empty-state svg { opacity: 0.3; }
      `}</style>
      
      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
      
      {/* Header */}
      <div style={{ padding: "16px 24px", borderBottom: "1px solid #1E2730", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#0F1419" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#00AEEF", letterSpacing: "1.5px", textTransform: "uppercase" }}>Image Metadata Manager</div>
          <div style={{ fontSize: 11, color: "#4E5D6B", fontFamily: "'JetBrains Mono', monospace" }}>EXIF · IPTC · XMP · Descriptive & Administrative</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {selected && (
            <>
              <button className="btn btn-secondary" onClick={exportMetadata}>
                <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                Export JSON
              </button>
            </>
          )}
          <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
            Add Images
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => handleFiles(e.target.files)} />
        </div>
      </div>
      
      {/* Main Layout */}
      <div style={{ display: "flex", height: "calc(100vh - 65px)" }}>
        
        {/* Left: File List */}
        <div style={{ width: 280, borderRight: "1px solid #1E2730", display: "flex", flexDirection: "column", flexShrink: 0, background: "#0F1419" }}>
          <div className="section-title">Files ({files.length})</div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {files.length === 0 ? (
              <div style={{ padding: 24 }}>
                <div
                  className={`drop-zone ${dragOver ? "active" : ""}`}
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="#4E5D6B" strokeWidth="1.5" style={{ marginBottom: 8 }}>
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                  </svg>
                  <div style={{ fontSize: 13, color: "#6B7A8D", fontWeight: 500 }}>Drop images here</div>
                  <div style={{ fontSize: 11, color: "#3A4553", marginTop: 4 }}>or click to browse</div>
                </div>
              </div>
            ) : (
              <>
                <div
                  style={{ margin: "4px 12px 8px", padding: "6px 0", borderBottom: "1px dashed #1E2730" }}
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                >
                  <div
                    className={`drop-zone ${dragOver ? "active" : ""}`}
                    style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="#4E5D6B" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                    <span style={{ fontSize: 11, color: "#4E5D6B" }}>Add more images</span>
                  </div>
                </div>
                {files.map((f, i) => (
                  <div
                    key={`${f.name}-${i}`}
                    className={`file-item ${selectedIdx === i ? "active" : ""}`}
                    onClick={() => { setSelectedIdx(i); setEditMode(false); setShowAllMeta(false); }}
                  >
                    <img className="file-thumb" src={f.dataUrl} alt="" />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#C8D2DC", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 150 }}>{f.name}</div>
                      <div style={{ fontSize: 10, color: "#4E5D6B", fontFamily: "'JetBrains Mono', monospace" }}>
                        {f.width}×{f.height} · {(f.size / 1024).toFixed(0)}KB
                      </div>
                      {f.userMeta.title && <div style={{ fontSize: 10, color: "#4A90D9", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 150 }}>{f.userMeta.title}</div>}
                    </div>
                    <button className="remove-btn" onClick={(e) => { e.stopPropagation(); removeFile(i); }} title="Remove">×</button>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
        
        {/* Center/Right: Detail area */}
        {!selected ? (
          <div style={{ flex: 1, display: "flex" }}>
            <div
              className="empty-state"
              style={{ flex: 1 }}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
            >
              <svg width="56" height="56" fill="none" viewBox="0 0 24 24" stroke="#2A3440" strokeWidth="1">
                <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
              </svg>
              <div style={{ fontSize: 14, fontWeight: 500, color: "#3A4553" }}>No image selected</div>
              <div style={{ fontSize: 12, color: "#2A3440" }}>Drop images anywhere or use the Add button</div>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            
            {/* Center: Preview + Technical */}
            <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
              {/* Preview */}
              <div className="panel" style={{ marginBottom: 16 }}>
                <div style={{ position: "relative", background: "#0A0F14", display: "flex", alignItems: "center", justifyContent: "center", maxHeight: 340, overflow: "hidden" }}>
                  <img
                    src={selected.dataUrl}
                    alt={selected.name}
                    style={{ maxWidth: "100%", maxHeight: 340, objectFit: "contain", display: "block" }}
                  />
                </div>
                <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: "1px solid #1E2730" }}>
                  <div>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "#E0E6EC" }}>{selected.name}</span>
                    <span style={{ fontSize: 11, color: "#4E5D6B", marginLeft: 10, fontFamily: "'JetBrains Mono', monospace" }}>
                      {selected.type} · {(selected.size / 1024).toFixed(0)} KB · {selected.lastModified}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <span className="tag-badge tag-exif">EXIF</span>
                    {Object.keys(selected.exif).some(k => k.startsWith("IPTC:")) && <span className="tag-badge tag-iptc">IPTC</span>}
                    {selected.userMeta.title && <span className="tag-badge tag-user">USER</span>}
                  </div>
                </div>
              </div>

              {/* Technical Summary */}
              <div className="panel" style={{ marginBottom: 16 }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid #1E2730", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#A0AEBB", letterSpacing: "-0.2px" }}>
                    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="#4A90D9" strokeWidth="2" style={{ marginRight: 8, verticalAlign: -2 }}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                    Technical Metadata
                  </span>
                  <span className="tag-badge tag-exif">EXIF</span>
                </div>
                <div className="meta-grid">
                  {techSummary.map(({ label, value }) => (
                    <div className="meta-cell" key={label}>
                      <div className="meta-label">{label}</div>
                      <div className={`meta-value ${value !== "—" ? "highlight" : ""}`}>{String(value)}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* GPS if present */}
              {(selected.exif.GPSLatitude || selected.exif.GPSLongitude) && (
                <div className="panel" style={{ marginBottom: 16 }}>
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid #1E2730" }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#A0AEBB" }}>
                      <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="#4A90D9" strokeWidth="2" style={{ marginRight: 8, verticalAlign: -2 }}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      GPS Location
                    </span>
                  </div>
                  <div className="meta-grid">
                    <div className="meta-cell">
                      <div className="meta-label">Latitude</div>
                      <div className="meta-value highlight">{selected.exif.GPSLatitude} {selected.exif.GPSLatitudeRef || ""}</div>
                    </div>
                    <div className="meta-cell">
                      <div className="meta-label">Longitude</div>
                      <div className="meta-value highlight">{selected.exif.GPSLongitude} {selected.exif.GPSLongitudeRef || ""}</div>
                    </div>
                    {selected.exif.GPSAltitude && (
                      <div className="meta-cell">
                        <div className="meta-label">Altitude</div>
                        <div className="meta-value">{selected.exif.GPSAltitude}</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* All Metadata (expandable) */}
              <div className="panel">
                <div
                  style={{ padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between" }}
                  onClick={() => setShowAllMeta(!showAllMeta)}
                >
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#A0AEBB" }}>
                    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="#4A90D9" strokeWidth="2" style={{ marginRight: 8, verticalAlign: -2 }}><path d="M4 6h16M4 12h16M4 18h16"/></svg>
                    All Metadata Fields ({Object.keys(selected.exif).length} tags)
                  </span>
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="#6B7A8D" strokeWidth="2" style={{ transform: showAllMeta ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
                    <path d="M6 9l6 6 6-6"/>
                  </svg>
                </div>
                {showAllMeta && (
                  <div style={{ borderTop: "1px solid #1E2730" }}>
                    {Object.entries(selected.exif).sort(([a],[b]) => a.localeCompare(b)).map(([key, value]) => (
                      <div className="all-meta-row" key={key}>
                        <div>{key}</div>
                        <div>{String(value)}</div>
                      </div>
                    ))}
                    {Object.keys(selected.exif).length === 0 && (
                      <div style={{ padding: 16, color: "#3A4553", fontSize: 12, textAlign: "center" }}>
                        No EXIF/IPTC metadata found in this file. Metadata may have been stripped or the format is not supported.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            
            {/* Right: Descriptive & Admin Panel */}
            <div style={{ width: 340, borderLeft: "1px solid #1E2730", overflowY: "auto", flexShrink: 0, background: "#0F1419" }}>
              
              {/* Mode header */}
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #1E2730", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "#0F1419", zIndex: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#A0AEBB" }}>
                  {editMode ? "Edit Metadata" : "Descriptive & Administrative"}
                </span>
                {!editMode ? (
                  <button className="btn btn-primary" onClick={startEdit} style={{ fontSize: 11, padding: "5px 12px" }}>
                    <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Edit
                  </button>
                ) : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-danger" onClick={cancelEdit} style={{ fontSize: 11, padding: "5px 12px" }}>Cancel</button>
                    <button className="btn btn-success" onClick={saveEdit} style={{ fontSize: 11, padding: "5px 12px" }}>
                      <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg>
                      Save
                    </button>
                  </div>
                )}
              </div>
              
              <div style={{ padding: "8px 16px 16px" }}>
                {/* Descriptive section */}
                <div className="section-title" style={{ padding: "12px 0 8px", color: "#4A90D9" }}>Descriptive Metadata</div>
                
                {editMode ? (
                  descriptiveFields.map(f => (
                    <div className="field-group" key={f.key}>
                      <div className="field-label">
                        <span>{f.label}</span>
                        <span>{f.help}</span>
                      </div>
                      {f.type === "textarea" ? (
                        <textarea
                          className="field-input"
                          value={editData[f.key] || ""}
                          onChange={e => setEditData(d => ({ ...d, [f.key]: e.target.value }))}
                          placeholder={`Enter ${f.label.toLowerCase()}...`}
                        />
                      ) : (
                        <input
                          className="field-input"
                          type="text"
                          value={editData[f.key] || ""}
                          onChange={e => setEditData(d => ({ ...d, [f.key]: e.target.value }))}
                          placeholder={`Enter ${f.label.toLowerCase()}...`}
                        />
                      )}
                    </div>
                  ))
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "#1E2730", borderRadius: 6, overflow: "hidden" }}>
                    {descriptiveFields.map(f => (
                      <div key={f.key} style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 1 }}>
                        <div style={{ padding: "7px 10px", background: "#141B22", fontSize: 11, color: "#6B7A8D", fontWeight: 500 }}>{f.label}</div>
                        <div style={{ padding: "7px 10px", background: "#0F1419", fontSize: 12, color: selected.userMeta[f.key] ? "#C8D2DC" : "#2A3440" }}>
                          {selected.userMeta[f.key] || "—"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                
                {/* Administrative section */}
                <div className="section-title" style={{ padding: "20px 0 8px", color: "#D9A04A" }}>Administrative Metadata</div>
                
                {editMode ? (
                  adminFields.map(f => (
                    <div className="field-group" key={f.key}>
                      <div className="field-label">
                        <span>{f.label}</span>
                        <span>{f.help}</span>
                      </div>
                      {f.type === "textarea" ? (
                        <textarea
                          className="field-input"
                          value={editData[f.key] || ""}
                          onChange={e => setEditData(d => ({ ...d, [f.key]: e.target.value }))}
                          placeholder={`Enter ${f.label.toLowerCase()}...`}
                        />
                      ) : f.type === "select" ? (
                        <select
                          className="field-input"
                          value={editData[f.key] || ""}
                          onChange={e => setEditData(d => ({ ...d, [f.key]: e.target.value }))}
                        >
                          {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input
                          className="field-input"
                          type="text"
                          value={editData[f.key] || ""}
                          onChange={e => setEditData(d => ({ ...d, [f.key]: e.target.value }))}
                          placeholder={`Enter ${f.label.toLowerCase()}...`}
                        />
                      )}
                    </div>
                  ))
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "#1E2730", borderRadius: 6, overflow: "hidden" }}>
                    {adminFields.map(f => (
                      <div key={f.key} style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 1 }}>
                        <div style={{ padding: "7px 10px", background: "#141B22", fontSize: 11, color: "#6B7A8D", fontWeight: 500 }}>{f.label}</div>
                        <div style={{ padding: "7px 10px", background: "#0F1419", fontSize: 12, color: selected.userMeta[f.key] ? "#C8D2DC" : "#2A3440" }}>
                          {selected.userMeta[f.key] || "—"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                
                {/* IPTC from file (if any) */}
                {Object.keys(selected.exif).some(k => k.startsWith("IPTC:")) && (
                  <>
                    <div className="section-title" style={{ padding: "20px 0 8px", color: "#4AD98A" }}>Embedded IPTC Data</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "#1E2730", borderRadius: 6, overflow: "hidden" }}>
                      {Object.entries(selected.exif).filter(([k]) => k.startsWith("IPTC:")).map(([k, v]) => (
                        <div key={k} style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 1 }}>
                          <div style={{ padding: "7px 10px", background: "#141B22", fontSize: 11, color: "#6B7A8D", fontWeight: 500 }}>{k.replace("IPTC:", "")}</div>
                          <div style={{ padding: "7px 10px", background: "#0F1419", fontSize: 12, color: "#C8D2DC" }}>{v}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* ExifTool hint */}
                <div style={{ marginTop: 20, padding: 12, background: "#0A0F14", border: "1px solid #1E2730", borderRadius: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#4A90D9", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6, fontFamily: "'JetBrains Mono', monospace" }}>
                    Write to file with ExifTool
                  </div>
                  <div style={{ fontSize: 10, color: "#4E5D6B", fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.6, wordBreak: "break-all" }}>
                    {selected.userMeta.title && <div>-IPTC:ObjectName="{selected.userMeta.title}"</div>}
                    {selected.userMeta.description && <div>-IPTC:Caption-Abstract="{selected.userMeta.description.substring(0,40)}..."</div>}
                    {selected.userMeta.keywords && <div>-IPTC:Keywords="{selected.userMeta.keywords}"</div>}
                    {selected.userMeta.creator && <div>-IPTC:By-line="{selected.userMeta.creator}"</div>}
                    {selected.userMeta.copyright && <div>-IPTC:CopyrightNotice="{selected.userMeta.copyright}"</div>}
                    {!selected.userMeta.title && !selected.userMeta.description && (
                      <div style={{ color: "#3A4553" }}>Edit metadata to generate ExifTool commands</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
