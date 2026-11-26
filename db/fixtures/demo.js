/**
 * Fixtures de prueba (solo `npm run db:seed:demo` / `node db/seed.js --demo`): usuarios demo.<industria>@knet.local,
 * matches ficticios por industria y asistentes simulados del QR. Los usan smoke, test:ai y test:stream (CI).
 * No forman parte del catálogo real: `npm run db:seed` (sin --demo) los quita de `contacts` y no crea usuarios demo.
 */

/** Matches ficticios por industria: [iniciales, nombre, titular, afinidad, motivo] */
export const MATCHES = {
    banca: [["DC", "Daniela C.", "Directora de Datos · Aseguradora", 94, "Ambas lideran modelos de scoring con IA"], ["DR", "Diego R.", "CTO · Fintech de pagos", 89, "Busca un banco aliado para piloto de Open Finance"], ["MV", "Mateo V.", "Partner · Riesgo regulatorio", 82, "Expuso sobre explicabilidad de modelos"]],
    tech: [["LM", "Laura M.", "VP de Plataforma · Retail", 92, "Migró a una arquitectura de agentes en 2026"], ["SA", "Santiago A.", "Head de Data · Telco", 87, "Comparten interés en evaluación de RAG"], ["CP", "Camila P.", "Founder · Startup de observabilidad", 81, "Busca design partners"]],
    consultoria: [["AR", "Andrés R.", "COO · Manufactura", 91, "Explora un programa de IA a escala"], ["VG", "Valentina G.", "CHRO · Retail", 86, "Lidera reskilling para 3.000 personas"], ["JT", "Julián T.", "Director de Innovación · Salud", 80, "Busca casos de uso validados"]],
    energia: [["NS", "Natalia S.", "VP de Sostenibilidad · Utility", 90, "Comparten metas de descarbonización"], ["FL", "Felipe L.", "Head de IoT · Oil & Gas", 85, "Implementó gemelos digitales en 4 plantas"], ["PB", "Paula B.", "Gerente de Compras · Minería", 79, "Busca proveedores con trazabilidad"]]
  };

export const PERSONAS = {
    banca: { name: "Carlos Restrepo", initials: "CR", company: "Banco Pacífico Andino", seniority: "Directivo", interests: ["Riesgo crediticio", "Open Finance", "IA explicable"], location: "Bogotá, Colombia" },
    tech: { name: "Daniela Ortiz", initials: "DO", company: "Nubia Software", seniority: "Gerencia", interests: ["Agentes de IA", "MCP", "RAG"], location: "Medellín, Colombia" },
    consultoria: { name: "Sofía Herrera", initials: "SH", company: "Andes Advisory", seniority: "Gerencia", interests: ["Escalar IA", "Gestión del cambio", "Métricas de valor"], location: "Lima, Perú" },
    energia: { name: "Martín Rojas", initials: "MR", company: "Energía del Valle", seniority: "Directivo", interests: ["Gemelos digitales", "Mantenimiento predictivo", "Transición energética"], location: "Cali, Colombia" }
  };

export const MATCH_INFO = {
    "Daniela C.": { int: ["Riesgo crediticio", "IA explicable", "Gobierno de datos"], likes: ["Ciclismo de ruta", "Podcasts de fintech"], goal: "validar modelos de scoring con pares de banca" },
    "Diego R.": { int: ["Open Finance", "Pagos en tiempo real", "APIs abiertas"], likes: ["Café de especialidad", "Hackathons"], goal: "encontrar un banco aliado para un piloto de Open Finance" },
    "Mateo V.": { int: ["IA explicable", "Regulación financiera", "Riesgo crediticio"], likes: ["Ajedrez", "Libros de no ficción"], goal: "reunir casos reales para un estudio regulatorio" },
    "Laura M.": { int: ["Agentes de IA", "MCP", "Plataformas internas"], likes: ["Trail running", "Open source"], goal: "compartir lo que aprendió migrando a agentes" },
    "Santiago A.": { int: ["RAG", "Evaluación de modelos", "Datos"], likes: ["Fotografía", "Juegos de mesa"], goal: "comparar costos de RAG con otros equipos" },
    "Camila P.": { int: ["Agentes de IA", "Observabilidad", "Startups"], likes: ["Escalada", "Diseño de producto"], goal: "conseguir design partners para su producto" },
    "Andrés R.": { int: ["Escalar IA", "Operaciones", "Manufactura"], likes: ["Fútbol", "Historia empresarial"], goal: "lanzar un programa de IA a escala en sus plantas" },
    "Valentina G.": { int: ["Gestión del cambio", "Reskilling", "Cultura"], likes: ["Yoga", "Mentoría"], goal: "liderar el reskilling de 3.000 personas" },
    "Julián T.": { int: ["Métricas de valor", "Escalar IA", "Innovación en salud"], likes: ["Senderismo", "Startups de salud"], goal: "encontrar casos de uso ya validados" },
    "Natalia S.": { int: ["Transición energética", "Gemelos digitales", "ESG"], likes: ["Kitesurf", "Energía solar en casa"], goal: "sumar aliados para sus metas de descarbonización" },
    "Felipe L.": { int: ["Gemelos digitales", "Mantenimiento predictivo", "IoT industrial"], likes: ["Drones", "Robótica"], goal: "escalar los gemelos digitales que ya tiene en 4 plantas" },
    "Paula B.": { int: ["Transición energética", "Cadena de suministro", "Trazabilidad"], likes: ["Cocina", "Viajes"], goal: "encontrar proveedores con trazabilidad" }
  };

export const OTHERS = [["Valentina G.", 1480], ["Diego R.", 1310], ["Santiago A.", 1120], ["Camila P.", 980], ["Mateo V.", 760], ["Julián T.", 540]];

export const SUMMIT_POOL = [["Andrea P.", "Head de Producto · Telco"], ["Ricardo M.", "CIO · Retail"], ["Juliana C.", "Data Scientist · Banca"], ["Tomás V.", "Arquitecto Cloud · Seguros"], ["Mariana Q.", "Directora de Innovación · Salud"], ["Sebastián O.", "CTO · Logística"], ["Lucía F.", "Product Manager · Fintech"], ["Esteban R.", "Gerente de Datos · Energía"], ["Óscar N.", "Head de IA · Gobierno"], ["Isabel D.", "VP Estrategia · Consumo"], ["Hernán G.", "Director de TI · Minería"], ["Carolina E.", "Líder de Ciberseguridad · Banca"], ["Manuel K.", "Fundador · Startup de IA"], ["Gabriela H.", "Consultora · Transformación"]];
