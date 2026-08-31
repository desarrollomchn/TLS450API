-- Capacidad real de tanques (galones) para las 5 estaciones TEXACO, tomada de CapacidadTanques.xlsx.
-- ComEstacionId = comb_estaciones.Id (no gen_estaciones.Id).

INSERT INTO comb_capacidades (ComEstacionId, Producto, CapacidadGalones) VALUES
(3, 'DIESEL',   10000),  -- Estrella Este
(3, 'SUPER',    10000),
(3, 'REGULAR',  10000),
(4, 'DIESEL',   10000),  -- Aeropuerto
(4, 'SUPER',    10000),
(4, 'REGULAR',  10000),
(5, 'DIESEL',   10000),  -- Villa Olímpica
(5, 'SUPER',    10000),
(5, 'REGULAR',  10000),
(7, 'DIESEL',   10000),  -- Victoria
(7, 'SUPER',    10000),
(7, 'REGULAR',  10000),
(9, 'DIESEL',   17000),  -- Toyos
(9, 'SUPER',    6700),
(9, 'REGULAR',  6000);
GO
