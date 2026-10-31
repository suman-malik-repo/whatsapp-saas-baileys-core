function formatPhone(phone) {
 if (typeof phone !== "string") {
  throw new TypeError("phone must be a string")
 }
 if (phone.length > 64) {
  throw new TypeError("phone must be at most 64 characters")
 }
 if (!/^ *\+?[\d ()-]+ *$/.test(phone)) {
  throw new TypeError("phone must contain an international number with an optional leading + and only digits, spaces, parentheses or hyphens")
 }

 const input = phone.trim()
 const digits = input.replace(/\D/g, "")
 if (!/^[1-9]\d{6,14}$/.test(digits)) {
  throw new TypeError("phone must contain 7 to 15 digits including the country code and must not start with 0")
 }

 return `${digits}@s.whatsapp.net`
}

module.exports = formatPhone

