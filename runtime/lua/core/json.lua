-- json.lua — engine JSON bridge (Lua side of the JS<->Lua data path)
-- MIT-style minimal JSON encoder/decoder (based on rxi/json.lua, rewritten).
-- All engine capability calls exchange structured data as JSON strings,
-- so real Lua tables (pairs/ipairs-safe) are produced Lua-side.

local json = { _version = "0.1.2" }

-- ---------- encode ----------

local encode

local escape_map = {
  [ "\\" ] = "\\\\", [ "\"" ] = "\\\"", [ "\n" ] = "\\n",
  [ "\r" ] = "\\r", [ "\t" ] = "\\t", [ "\b" ] = "\\b", [ "\f" ] = "\\f",
}

local function escape_char(c)
  return escape_map[c] or string.format("\\u%.4x", c:byte())
end

local function encode_string(s)
  return '"' .. s:gsub("[%z\1-\31\\\"]", escape_char) .. '"'
end

local function encode_number(n)
  if n ~= n or n == math.huge or n == -math.huge then return "null" end
  if math.type(n) == "integer" then return tostring(n) end
  local s = string.format("%.14g", n)
  return s
end

local function encode_table(val, stack)
  stack = stack or {}
  if stack[val] then error("circular reference", 0) end

  -- array? (has [1] or is empty) -- engine data never mixes array/object
  local is_array = rawget(val, 1) ~= nil or next(val) == nil
  local parts = {}
  if is_array then
    local n = 0
    for k in pairs(val) do
      if type(k) ~= "number" then error("mixed table: not a pure array", 0) end
      if k > n then n = k end
    end
    for i = 1, n do
      stack[val] = true
      parts[i] = encode(val[i], stack)
      stack[val] = nil
    end
    return "[" .. table.concat(parts, ",") .. "]"
  else
    for k, v in pairs(val) do
      if type(k) ~= "string" then error("mixed table: non-string key", 0) end
      stack[val] = true
      parts[#parts + 1] = encode_string(k) .. ":" .. encode(v, stack)
      stack[val] = nil
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
end

encode = function(val, stack)
  local t = type(val)
  if t == "nil" then return "null"
  elseif t == "boolean" then return val and "true" or "false"
  elseif t == "number" then return encode_number(val)
  elseif t == "string" then return encode_string(val)
  elseif t == "table" then return encode_table(val, stack)
  else error("cannot encode type '" .. t .. "'", 0) end
end

function json.encode(val)
  return (encode(val, nil))
end

-- ---------- decode ----------

local function decode_error(str, idx, msg)
  error(string.format("invalid JSON at %d: %s", idx, msg), 0)
end

local function skip_ws(str, idx)
  local _, e = str:find("^[ \t\r\n]*", idx)
  return e + 1
end

local escape_rev = {
  [ '"' ] = '"', [ "\\" ] = "\\", [ "/" ] = "/",
  [ "b" ] = "\b", [ "f" ] = "\f", [ "n" ] = "\n", [ "r" ] = "\r", [ "t" ] = "\t",
}

local parse

local NULL_MARK = {}   -- JSON null 标记：对象字段剥离（键不存在），数组槽位以 false 占位

parse = function(str, idx)
  idx = skip_ws(str, idx)
  local c = str:sub(idx, idx)

  if c == "{" then
    local obj = {}
    idx = skip_ws(str, idx + 1)
    if str:sub(idx, idx) == "}" then return obj, idx + 1 end
    while true do
      if str:sub(idx, idx) ~= '"' then
        decode_error(str, idx, "expected object key string")
      end
      local key
      key, idx = parse(str, idx)
      idx = skip_ws(str, idx)
      if str:sub(idx, idx) ~= ":" then decode_error(str, idx, "expected ':'") end
      local val
      val, idx = parse(str, idx + 1)
      if val ~= NULL_MARK then obj[key] = val end
      idx = skip_ws(str, idx)
      local chr = str:sub(idx, idx)
      if chr == "," then
        idx = skip_ws(str, idx + 1)
      elseif chr == "}" then
        return obj, idx + 1
      else
        decode_error(str, idx, "expected ',' or '}'")
      end
    end
  elseif c == "[" then
    local arr = {}
    idx = skip_ws(str, idx + 1)
    if str:sub(idx, idx) == "]" then return arr, idx + 1 end
    while true do
      local val
      val, idx = parse(str, idx)
      arr[#arr + 1] = (val == NULL_MARK) and false or val
      idx = skip_ws(str, idx)
      local chr = str:sub(idx, idx)
      if chr == "," then
        idx = skip_ws(str, idx + 1)
      elseif chr == "]" then
        return arr, idx + 1
      else
        decode_error(str, idx, "expected ',' or ']'")
      end
    end
  elseif c == '"' then
    local out = {}
    idx = idx + 1
    while true do
      local chr = str:sub(idx, idx)
      if chr == "" then decode_error(str, idx, "unterminated string") end
      if chr == '"' then
        return table.concat(out), idx + 1
      elseif chr == "\\" then
        local nxt = str:sub(idx + 1, idx + 1)
        if nxt == "u" then
          local hex = str:sub(idx + 2, idx + 5)
          local code = tonumber(hex, 16)
          if not code then decode_error(str, idx, "invalid \\u escape") end
          out[#out + 1] = utf8.char(code)
          idx = idx + 6
        else
          local mapped = escape_rev[nxt]
          if not mapped then decode_error(str, idx, "invalid escape '\\" .. nxt .. "'") end
          out[#out + 1] = mapped
          idx = idx + 2
        end
      else
        out[#out + 1] = chr
        idx = idx + 1
      end
    end
  elseif c == "t" then
    if str:sub(idx, idx + 3) == "true" then return true, idx + 4 end
    decode_error(str, idx, "unexpected token")
  elseif c == "f" then
    if str:sub(idx, idx + 4) == "false" then return false, idx + 5 end
    decode_error(str, idx, "unexpected token")
  elseif c == "n" then
    if str:sub(idx, idx + 3) == "null" then return NULL_MARK, idx + 4 end
    decode_error(str, idx, "unexpected token")
  else
    local num = str:match("^%-?%d+%.?%d*[eE]?[-+]?%d*", idx)
    if num then
      return tonumber(num), idx + #num
    end
    decode_error(str, idx, "unexpected character '" .. c .. "'")
  end
end

function json.decode(str)
  if type(str) ~= "string" or str == "" then
    error("json.decode: expected non-empty string", 0)
  end
  local res, idx = parse(str, 1)
  idx = skip_ws(str, idx)
  if idx <= #str then decode_error(str, idx, "trailing garbage") end
  return res
end

return json
