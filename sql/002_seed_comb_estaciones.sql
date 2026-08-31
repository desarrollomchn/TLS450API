-- Seed inicial de comb_estaciones: las 10 estaciones del Excel de controladores
-- que tienen IP real de Veeder-Root configurada.

INSERT INTO comb_estaciones (EstacionId, Host, Activo) VALUES
(18, '192.168.5.40', 1),   -- UNO Choluteca
(21, '192.168.8.56', 1),   -- SHELL Millennium
(9,  '192.168.9.56', 1),   -- TEXACO Estrella Este
(10, '192.168.10.51', 1),  -- TEXACO Aeropuerto
(8,  '192.168.11.50', 1),  -- TEXACO Villa Olímpica
(20, '192.168.31.55', 1),  -- UNO Cedros
(4,  '192.168.14.56', 1),  -- TEXACO Victoria
(35, '192.168.32.25', 1),  -- UNO Expocentro
(11, '192.168.20.51', 1),  -- TEXACO Toyos
(28, '192.168.210.52', 1); -- PUMA San Diego
