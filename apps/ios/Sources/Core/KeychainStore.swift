import Foundation
import Security

struct KeychainStore {
    private let service = "app.shelly.ios"
    private let account = "paired-daemon"

    func save<T: Encodable>(_ value: T) throws {
        let data = try JSONEncoder.shelly.encode(value)
        let query = baseQuery
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]

        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess {
            return
        }
        if status != errSecItemNotFound {
            throw KeychainError.unexpected(status)
        }

        var addQuery = query
        attributes.forEach { addQuery[$0.key] = $0.value }
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError.unexpected(addStatus)
        }
    }

    func load<T: Decodable>(_ type: T.Type) throws -> T {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else {
            throw KeychainError.unexpected(status)
        }
        guard let data = result as? Data else {
            throw KeychainError.invalidData
        }
        return try JSONDecoder.shelly.decode(T.self, from: data)
    }

    func delete() throws {
        let query = baseQuery
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpected(status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true
        ]
    }
}

enum KeychainError: LocalizedError {
    case invalidData
    case unexpected(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidData:
            "Stored pairing data is unreadable."
        case .unexpected(let status):
            "Keychain operation failed with status \(status)."
        }
    }
}

extension JSONEncoder {
    static var shelly: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

extension JSONDecoder {
    static var shelly: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
