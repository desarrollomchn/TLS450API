-- Capacidad real de tanques (galones) para las 34 estaciones de combustible de
-- gen_estaciones (excluye las 5 filas que no son estación de venta de combustible,
-- ej. oficina/hidroeléctrica). EstacionId = gen_estaciones.Id en todas las filas,
-- no comb_estaciones.Id -- una estación sin fila en comb_estaciones (sin Veeder-Root
-- instalado todavía) puede tener capacidad cargada igual. Si un producto no tiene
-- valor real para una estación (ej. sin tanque de Kerosene) no se inserta fila --
-- nunca se siembra un 0/NULL inventado.

INSERT INTO comb_capacidades (EstacionId, Producto, CapacidadGalones) VALUES
(30, 'DIESEL',    5000),
(30, 'SUPER',     6000),
(30, 'REGULAR',   3000),
(30, 'KEROSENE',  2000),

(34, 'DIESEL',    5050),
(34, 'SUPER',     5000),
(34, 'REGULAR',   4050),
(34, 'KEROSENE',   750),

(31, 'DIESEL',    5000),
(31, 'SUPER',     5000),
(31, 'REGULAR',   3650),
(31, 'KEROSENE',   750),

(32, 'DIESEL',    7000),
(32, 'SUPER',     5000),
(32, 'REGULAR',   5000),

(29, 'DIESEL',    5000),
(29, 'SUPER',     5000),
(29, 'REGULAR',   3000),
(29, 'KEROSENE',    55),

(27, 'DIESEL',    7000),
(27, 'SUPER',     7000),
(27, 'REGULAR',   7000),
(27, 'KEROSENE',   800),

(24, 'DIESEL',   10000),
(24, 'SUPER',     7000),
(24, 'REGULAR',   7000),
(24, 'KEROSENE',   800),

(26, 'DIESEL',    7000),
(26, 'SUPER',     7000),
(26, 'REGULAR',   3000),

(25, 'DIESEL',   10000),
(25, 'SUPER',     7000),
(25, 'REGULAR',   5000),
(25, 'KEROSENE',    55),

(28, 'DIESEL',    8000),
(28, 'SUPER',     8000),
(28, 'REGULAR',   5000),
(28, 'KEROSENE',  2000),

(33, 'DIESEL',    3000),
(33, 'SUPER',     6000),
(33, 'REGULAR',   6000),
(33, 'KEROSENE',    55),

(2,  'DIESEL',   10000),
(2,  'SUPER',    10000),
(2,  'REGULAR',  10000),

(6,  'DIESEL',   10000),
(6,  'SUPER',    10000),
(6,  'REGULAR',  10000),

(13, 'DIESEL',   10000),
(13, 'SUPER',    10000),
(13, 'REGULAR',  10000),

(18, 'DIESEL',   10000),
(18, 'SUPER',    10000),
(18, 'REGULAR',  10000),
(18, 'KEROSENE',  6000),

(19, 'DIESEL',   15000),
(19, 'SUPER',    10000),
(19, 'REGULAR',  10000),
(19, 'KEROSENE',  2000),

(5,  'DIESEL',   10000),
(5,  'SUPER',    10000),
(5,  'REGULAR',  10000),

(21, 'DIESEL',   10000),
(21, 'SUPER',    10000),
(21, 'REGULAR',  10000),
(21, 'KEROSENE',  6093),

(9,  'DIESEL',   10000),
(9,  'SUPER',    10000),
(9,  'REGULAR',  10000),

(10, 'DIESEL',   10000),
(10, 'SUPER',    10000),
(10, 'REGULAR',  10000),

(8,  'DIESEL',   10000),
(8,  'SUPER',    10000),
(8,  'REGULAR',  10000),

(7,  'DIESEL',   10000),
(7,  'SUPER',    10000),
(7,  'REGULAR',  10000),

(16, 'DIESEL',   10000),
(16, 'SUPER',    10000),
(16, 'REGULAR',  10000),

(4,  'DIESEL',   10000),
(4,  'SUPER',    10000),
(4,  'REGULAR',  10000),

(3,  'DIESEL',   20000),
(3,  'SUPER',    10200),
(3,  'REGULAR',  10200),
(3,  'KEROSENE',  5000),

(15, 'DIESEL',   10000),
(15, 'SUPER',     5000),
(15, 'REGULAR',   2500),

(11, 'DIESEL',   17000),
(11, 'SUPER',     6700),
(11, 'REGULAR',   6000),

(17, 'DIESEL',    7000),
(17, 'SUPER',     7000),
(17, 'REGULAR',   5000),
(17, 'KEROSENE',  3000),

(12, 'DIESEL',   10000),
(12, 'SUPER',     8000),
(12, 'REGULAR',   5000),

(23, 'DIESEL',    8000),
(23, 'SUPER',     8000),
(23, 'REGULAR',   6000),
(23, 'KEROSENE',  5000),

(22, 'DIESEL',   10000),
(22, 'SUPER',    10000),
(22, 'REGULAR',   5000),
(22, 'KEROSENE',  5000),

(35, 'DIESEL',   10000),
(35, 'SUPER',    10000),
(35, 'REGULAR',  10000),

(14, 'DIESEL',    5000),
(14, 'SUPER',     5000),
(14, 'REGULAR',   5000),

(20, 'DIESEL',   10000),
(20, 'SUPER',    10000),
(20, 'REGULAR',  10000),
(20, 'KEROSENE',  5000);
GO
